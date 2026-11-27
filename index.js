// @local/anti-drift
// Foundation-level anti-hallucination guard for every agent.
//
// L0 soft:   system-prompt section: facts only / never fabricate / no drift.
// L1 hard:   tools/pre-execute denies (a) editing/writing a file this session
//            never read and (b) destructive shell commands (rm/mv/>/sed -i/
//            tee/truncate/dd) aimed at a never-read path — blocks blind,
//            guess-based mutation.
// L2 audit:  tools/result + session/event(assistant/message) build a per-session
//            hallucination fingerprint: "not found" error streaks, repeated
//            identical calls (circles), fabricating-hedge language, and false
//            "done" claims with no supporting successful tool call.
// L3 fix:    agent/pre-step injects an escalating correction message into the
//            messages that enter the model. Pressure decays (not hard-reset) so
//            a continuing offender is caught on the very next step, and the
//            wording escalates remind -> warn -> command.

import { randomUUID } from 'node:crypto';

/** @typedef {{ language?: 'auto'|'zh'|'en', strictness?: 'standard'|'strict', enforce?: boolean, blockBlindEdit?: boolean, blockShellWrite?: boolean, detectFalseClaims?: boolean, repeatCancelThreshold?: number, correctionThreshold?: number }} AntiDriftConfig */

export const name = 'anti-drift';

export const inject = ['systemPrompt'];

const ZH_STANDARD = `## 反幻觉 · 反瞎编 · 不空转（必须遵守）

1. **只讲有依据的事实，绝不通编。** 只陈述能从工具结果、文件内容、命令输出或用户给定信息中确认的内容。没有依据的，要么先取证（读取 / 搜索 / 运行后再回答），要么明确标注“未验证的推测”。**绝不编造文件路径、接口、函数签名、命令输出、报错、引用或数字。**
2. **不确定就说不确定。** 拿不准时直说“我不确定/需要先查”，不要用看似合理的细节蒙混过去。
3. **声称完成必须有证据。** 说“已完成/已创建/已修改/已部署”之前，确认本会话确有对应的成功工具调用；没有就先做，做不到就如实说没做成。
4. **每一步都必须推进任务。** 每次回复都要有新的可验证进展；不空转、不空谈、不把同一结论换个说法再讲一遍。
5. **禁止原地打转与复读。** 不复述同一句话，不重复同一动作；上一轮没有新信息，就换一种具体做法。
6. **两次失败即换法。** 同一操作连续失败两次后必须换路径，并说明卡点与下一步。
7. **先给结果，再简述。** 不铺垫、不拖延、不空转。`;

const ZH_STRICT = `## 反幻觉（硬性）· 不瞎编 · 不复读

- **只讲事实：** 没核实的一律标“推测”，绝不编造路径 / 命令 / 输出 / 报错 / 引用。
- **拿不准就承认：** 不确定直接说不确定，需要就先取证。
- **完成需证据：** 声称“已完成/已创建/已修改”前，必须有本会话成功工具调用佐证。
- **每步推进：** 无新进展即失败。
- **禁止复读：** 不重复同一句、同一动作；两次失败必须换法并说明卡点。
- **直达结果：** 先交付再简述，不铺垫不空转。`;

const EN_STANDARD = `## Anti-hallucination · Never fabricate · No drift (mandatory)

1. **State only evidence-backed facts; never invent.** Assert only what you can confirm from tool results, file contents, command output, or user-provided information. For anything unverified, either gather evidence first (read / search / run, then answer) or mark it "unverified guess". **Never fabricate file paths, APIs, function signatures, command output, errors, citations, or numbers.**
2. **Say "I don't know" when unsure.** State uncertainty plainly instead of padding it with plausible-sounding detail.
3. **Claims of completion need evidence.** Before saying "done / created / fixed / deployed", confirm this session has the matching successful tool call; if not, do it first or say plainly it was not done.
4. **Every step must advance the task.** Each reply needs new, verifiable progress; no idling, no restating the same conclusion.
5. **No going in circles, no repetition.** Do not repeat the same sentence or loop the same action; if the last attempt yielded nothing new, switch approach.
6. **Two failures → change approach.** After two identical failures, switch paths and state the blocker and next step.
7. **Result first, then a brief note.** No preamble, no stalling, no idling.`;

const EN_STRICT = `## Anti-hallucination (hard) · Never fabricate · No repetition

- **Facts only:** mark anything unverified as "guess"; never fabricate paths / commands / output / errors / citations.
- **Admit uncertainty:** say "I don't know" plainly; gather evidence when needed.
- **Completion needs evidence:** before claiming done / created / fixed, this session must have the matching successful tool call.
- **Advance every step:** no new progress is failure.
- **No repetition:** never restate the same sentence or loop the same action; after two failures, change approach and name the blocker.
- **Straight to the result:** deliver first, then explain briefly; no preamble.`;

function resolveLang(config) {
  const mode = config?.language ?? 'auto';
  if (mode === 'zh' || mode === 'en') return mode;
  return 'zh';
}

function sectionText(config) {
  const lang = resolveLang(config);
  const strict = (config?.strictness ?? 'standard') === 'strict';
  if (lang === 'en') return strict ? EN_STRICT : EN_STANDARD;
  return strict ? ZH_STRICT : ZH_STANDARD;
}

// "Resource does not exist" style failures => evidence the model is guessing.
const NOT_FOUND_RE = /(not found|no such file|enoent|does not exist|不存在|找不到|cannot find|未能找到)/i;

// Hedge language suggesting fabricated rather than verified content.
const HEDGE_RE = /(应该是|大概是|我记得|我想是|估计是|假设.{0,6}(是|为)|我认为.{0,4}应该是|不确定.{0,4}(但|不过)|i (assume|think|guess|believe|recall)|probably|presumably|as far as i remember)/i;

// "Done" claims: text asserting completion that must be backed by a real tool call.
const DONE_CLAIM_RE = /(已完成|已创建|已修改|已修复|已部署|已删除|已生成|已写入|已运行|成功创建|成功修改|成功部署|done|completed|created|modified|fixed|deployed|deleted|implemented|generated|written|applied the (fix|change))/i;

const WRITE_TOOLS = new Set(['edit', 'write']);
const READ_TOOLS = new Set(['read']);
const SHELL_TOOLS = new Set(['bash', 'pwsh']);

// A shell command that mutates files; capture the target path if identifiable.
// Returns a path string when we can resolve one, or '' when it is destructive but
// the target is dynamic (still worth blocking if nothing has been read).
function shellWriteTargets(command, workdir) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const targets = new Set();
  const cwd = typeof workdir === 'string' && workdir ? workdir : '';

  // Tokenize respecting single/double quotes so paths with spaces stay whole.
  const tokenize = (s) => {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|([^\s|;&]+)/g;
    let mm;
    while ((mm = re.exec(String(s)))) {
      const tok = mm[1] ?? mm[2] ?? mm[3] ?? '';
      if (tok.length > 0) out.push(tok);
    }
    return out;
  };

  const paths = [];
  const rmRe = /\b(rm|unlink|rmdir|shred|truncate)\b([^|;&\n]*)/g;
  // mv/cp: the SOURCE is what gets moved-from or read-from; the DESTINATION is a
  // new/overwritten file we should not treat as "must read first" (creating a
  // fresh file is legitimate). Protect only the source (first path token).
  const mvRe = /\b(mv|cp)\b([^|;&\n]*)/g;
  const sedRe = /\bsed\b[^|;&\n]*\s-i\b([^|;&\n]*)/g;
  const ddRe = /\bdd\b[^|;&\n]*\bof=([^\s|;&]+)/g;
  const teeRe = /\btee\b([^|;&\n]*)/g;
  const redirectRe = /(?:^|[^>])>{1,2}\s*([^\s|;&>]+)/g;

  let m;
  while ((m = rmRe.exec(command))) for (const t of tokenize(m[2])) if (!t.startsWith('-')) paths.push(t);
  while ((m = mvRe.exec(command))) {
    const toks = tokenize(m[2]).filter((t) => !t.startsWith('-'));
    // Only the source (first) path is at risk; the destination may be new.
    if (toks.length > 0) paths.push(toks[0]);
  }
  while ((m = sedRe.exec(command))) for (const t of tokenize(m[1])) if (!t.startsWith('-')) paths.push(t);
  while ((m = ddRe.exec(command))) paths.push(m[1]);
  while ((m = teeRe.exec(command))) for (const t of tokenize(m[1])) if (!t.startsWith('-')) paths.push(t);
  while ((m = redirectRe.exec(command))) paths.push(m[1]);

  for (const p of paths) {
    const full = p.startsWith('/') || /^[A-Za-z]:/.test(p) || !cwd ? p : `${cwd}/${p}`;
    targets.add(full.replace(/\\/g, '/'));
  }
  return [...targets];
}

function pickPath(args) {
  if (args && typeof args === 'object') {
    for (const key of ['path', 'file_path', 'filePath', 'file', 'target']) {
      const v = args[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return undefined;
}

function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/\.\//g, '/');
}

function stableSignature(exec) {
  let argStr = '';
  try {
    argStr = JSON.stringify(exec.arguments ?? null);
  } catch {
    argStr = String(exec.arguments);
  }
  if (argStr.length > 512) argStr = argStr.slice(0, 512);
  return exec.name + '\u0000' + argStr;
}

// A tool call that actually produced an artifact / effect (evidence for "done").
function isEffectfulSuccess(exec, result) {
  if (!exec || !result || result.isError === true) return false;
  if (WRITE_TOOLS.has(exec.name)) return true;
  if (SHELL_TOOLS.has(exec.name)) return true;
  return false;
}

function extractText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  let out = '';
  for (const b of message.content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text + '\n';
  }
  return out;
}

function buildCorrectionMessage(text) {
  // Matches the UserMessage contract used by @deepseek-ai/dsh-llm's
  // createUserMessage: { id, role, content, source }. id is a fresh UUID brand.
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'anti-drift', form: 'notice', summary: text.slice(0, 120) },
  };
}

function newState() {
  return {
    seen: new Set(), // normalized paths successfully read this session
    evidence: 0, // count of effectful successful tool calls (write/shell)
    // audit counters
    notFound: 0,
    repeat: 0,
    lastSig: '',
    falseClaim: 0,
    hedge: 0,
    // escalating pressure + level
    pressure: 0,
    level: 0,
  };
}

/**
 * @param {import('cordis').Context} ctx
 * @param {AntiDriftConfig} config
 */
export function apply(ctx, config) {
  const raw = config ?? {};
  const cfg = {
    language: raw.language === 'en' || raw.language === 'zh' ? raw.language : 'auto',
    strictness: raw.strictness === 'strict' ? 'strict' : 'standard',
    enforce: raw.enforce !== false,
    blockBlindEdit: raw.blockBlindEdit !== false,
    blockShellWrite: raw.blockShellWrite !== false,
    detectFalseClaims: raw.detectFalseClaims !== false,
    repeatCancelThreshold:
      Number.isInteger(raw.repeatCancelThreshold) && raw.repeatCancelThreshold > 1
        ? raw.repeatCancelThreshold
        : 3,
    correctionThreshold:
      Number.isInteger(raw.correctionThreshold) && raw.correctionThreshold > 0
        ? raw.correctionThreshold
        : 2,
  };

  // Sharing notice: printed to the Host install/run log so anyone installing
  // this from a forum sees the intended use at activation time.
  try {
    ctx.logger?.info?.(
      'dsh-anti-drift v1.1.0 loaded — 本插件仅供分享学习，无其他用途。仅供分享学习，请勿用于其他目的。 / For sharing and study only; not for any other purpose.',
    );
  } catch {
    /* logging is best-effort */
  }

  // L0: soft guidance section.
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'anti-drift',
      order: 950,
      text: () => sectionText(cfg),
    }),
  );

  if (!cfg.enforce) return;

  /** @type {Map<string, ReturnType<typeof newState>>} */
  const sessions = new Map();
  const stateByKey = (key) => {
    let st = sessions.get(key);
    if (!st) {
      st = newState();
      sessions.set(key, st);
    }
    return st;
  };
  const keyOfAgent = (agent) => (agent?.id != null ? String(agent.id) : '<none>');
  const keyOfSession = (session) => (session?.id != null ? String(session.id) : '<none>');

  // L1a: hard gate for blind `edit`. We gate `edit` specifically (not `write`):
  // `edit` must match existing text and is the classic "patch from a guess"
  // risk, whereas `write` supplies full content the author already has and is
  // how new files are created — gating it would block legitimate new files.
  ctx.effect(() =>
    ctx.on('tools/pre-execute', (exec, next) => {
      if (!cfg.blockBlindEdit) return next();
      if (!exec || exec.name !== 'edit') return next();
      const p = pickPath(exec.arguments);
      if (p === undefined) return next();
      const st = stateByKey(keyOfAgent(exec.agent));
      if (st.seen.has(normPath(p))) return next();
      const zh = resolveLang(cfg) !== 'en';
      const reason = zh
        ? `[反幻觉闸] 拒绝盲改未取证的文件：${p}。本会话尚未读取该文件，禁止基于猜测修改。请先用 read 读取真实内容，再据实修改；若无法读取，请明确说明而不是编造。`
        : `[anti-drift gate] Blocked a blind edit of ${p}: this file was never read in this session. Read the real content first, then edit from facts; if it cannot be read, say so instead of inventing.`;
      return { kind: 'deny', reason, info: { name: exec.name, code: 'ANTI_DRIFT_BLIND_EDIT', reason } };
    }),
  );

  // L1b: hard gate for destructive shell writes against never-read paths.
  ctx.effect(() =>
    ctx.on('tools/pre-execute', (exec, next) => {
      if (!cfg.blockShellWrite) return next();
      if (!exec || !SHELL_TOOLS.has(exec.name)) return next();
      const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
      const command = args.command;
      const workdir = args.workdir;
      const targets = shellWriteTargets(command, workdir);
      if (targets.length === 0) return next();
      const st = stateByKey(keyOfAgent(exec.agent));
      // A target is "seen" when its full normalized path was read, or when its
      // basename matches any already-read path (tolerates quoting/relative forms
      // and paths with spaces without over-blocking legitimate work).
      const seenBasenames = new Set();
      for (const sp of st.seen) seenBasenames.add(sp.slice(sp.lastIndexOf('/') + 1));
      const isSeen = (t) => {
        const n = normPath(t);
        if (st.seen.has(n)) return true;
        const base = n.slice(n.lastIndexOf('/') + 1);
        return base.length > 0 && seenBasenames.has(base);
      };
      const unseen = targets.filter((t) => !isSeen(t));
      if (unseen.length === 0) return next();
      const zh = resolveLang(cfg) !== 'en';
      const list = unseen.slice(0, 3).join(', ');
      const reason = zh
        ? `[反幻觉闸] 拒绝盲改/盲删未取证路径：${list}。本会话尚未读取这些文件，禁止基于猜测执行破坏性命令。请先用 read/查看确认真实内容，再操作；若无法确认，请如实说明。`
        : `[anti-drift gate] Blocked a destructive command touching never-read path(s): ${list}. Read/inspect the real content first, then act; if it cannot be confirmed, say so instead of guessing.`;
      return { kind: 'deny', reason, info: { name: exec.name, code: 'ANTI_DRIFT_BLIND_SHELL', reason } };
    }),
  );

  // L2a: observe tool outcomes.
  ctx.effect(() =>
    ctx.on('tools/result', (exec, result) => {
      if (!exec) return;
      const st = stateByKey(keyOfAgent(exec.agent));
      const p = pickPath(exec.arguments);

      if (READ_TOOLS.has(exec.name) && p !== undefined && !(result && result.isError === true)) {
        st.seen.add(normPath(p));
      }

      if (isEffectfulSuccess(exec, result)) st.evidence += 1;

      if (result && result.isError === true) {
        let msg = '';
        try {
          msg = (result.error && result.error.message) || '';
          if (!msg && Array.isArray(result.content)) {
            msg = result.content.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ');
          }
        } catch {
          msg = '';
        }
        if (NOT_FOUND_RE.test(String(msg))) {
          st.notFound += 1;
          st.pressure += 1;
        }
      }

      const sig = stableSignature(exec);
      if (sig === st.lastSig) {
        st.repeat += 1;
        if (st.repeat >= cfg.repeatCancelThreshold) st.pressure += 1;
      } else {
        st.lastSig = sig;
        st.repeat = 1;
      }
    }),
  );

  // L2b: observe assistant text for hedge language and unbacked "done" claims.
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (!cfg.detectFalseClaims) return;
      if (!event || event.type !== 'assistant/message') return;
      const text = extractText(event.data && event.data.message);
      if (!text) return;
      const st = stateByKey(keyOfSession(session));

      if (HEDGE_RE.test(text)) {
        st.hedge += 1;
        st.pressure += 1;
      }
      // Claim of completion with no effectful evidence yet this session.
      if (DONE_CLAIM_RE.test(text) && st.evidence === 0) {
        st.falseClaim += 1;
        st.pressure += 1;
      }
    }),
  );

  // L3: inject an escalating correction before the next step.
  ctx.effect(() =>
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (!decision || decision.kind !== 'enter') return decision;
      if (payload && payload.signal && payload.signal.aborted) return decision;

      const st = stateByKey(keyOfAgent(payload?.agent));
      const zh = resolveLang(cfg) !== 'en';

      const notFoundHit = st.notFound >= cfg.correctionThreshold;
      const repeatHit = st.repeat >= cfg.repeatCancelThreshold;
      const falseClaimHit = st.falseClaim > 0;
      const hedgeHit = st.hedge >= cfg.correctionThreshold;

      if (!(notFoundHit || repeatHit || falseClaimHit || hedgeHit || st.pressure >= cfg.correctionThreshold)) {
        // Slow decay so a one-off blip fades, but sustained pressure persists.
        st.pressure = Math.max(0, st.pressure - 1);
        return decision;
      }

      st.level += 1;
      const lvl = Math.min(st.level, 3);

      const facts = [];
      if (notFoundHit) facts.push(zh ? `连续 ${st.notFound} 次“不存在/找不到”失败` : `${st.notFound} consecutive "not found" failures`);
      if (repeatHit) facts.push(zh ? `同一操作重复 ${st.repeat} 次无进展` : `the same action repeated ${st.repeat} times with no progress`);
      if (falseClaimHit) facts.push(zh ? `声称“已完成”但本会话无对应成功工具佐证` : `a "done" claim with no supporting successful tool call this session`);
      if (hedgeHit) facts.push(zh ? `出现 ${st.hedge} 次“大概是/我记得/假设”式猜测表述` : `${st.hedge} hedge/guess phrasings`);

      const factLine = facts.length
        ? (zh ? `检测到：${facts.join('；')}。` : `Detected: ${facts.join('; ')}.`)
        : (zh ? '检测到持续性的幻觉/空转迹象。' : 'Detected persistent hallucination/drift signals.');

      let body;
      if (lvl === 1) {
        body = zh
          ? `你刚才在猜测未验证的事实。立即停止编造：只用已成功读取/运行得到的内容，缺什么就如实说无法确认，不要凭猜测臆断。`
          : `You were guessing unverified facts. Stop fabricating: use only what was successfully read/run, and plainly state what cannot be confirmed.`;
      } else if (lvl === 2) {
        body = zh
          ? `警告：你仍未纠正，继续在编造或原地打转。禁止再编造任何路径/命令/输出/结论；不要重复同样动作。必须换一种具体做法，或直接说明卡点并停下。`
          : `Warning: not corrected — you keep fabricating or circling. Do not fabricate any path/command/output/conclusion; do not repeat the same action. Switch to a concrete different approach or state the blocker and stop.`;
      } else {
        body = zh
          ? `强命令：立即停止编造与重复。只输出你能用已获取证据支撑的内容；对无法确认的部分明确写“无法确认”。如果无法推进，直接如实汇报现状与卡点，不要再用猜测填补。`
          : `Hard stop: cease fabricating and repeating now. Output only what your gathered evidence supports; for anything unconfirmable, explicitly write "cannot confirm". If you cannot progress, report the current state and blocker honestly instead of filling gaps with guesses.`;
      }

      // Decay pressure and counters so one burst yields one correction per step,
      // but sustained misbehaviour keeps pressure high across steps.
      st.notFound = 0;
      st.repeat = 0;
      st.lastSig = '';
      st.falseClaim = 0;
      st.hedge = 0;
      st.pressure = Math.max(0, st.pressure - 2);

      const text = `${factLine}\n\n${body}`;
      return { ...decision, messages: [...decision.messages, buildCorrectionMessage(text)] };
    }),
  );
}

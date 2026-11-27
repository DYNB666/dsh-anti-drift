// dsh-anti-drift — Client half
// A compact status chip below the composer for the current session that
// surfaces the anti-drift fingerprint: "not found" error streaks (guessing),
// repeated identical tool calls (going in circles), and unbacked "done" claims
// (bluffing). It folds the session event window on the Client; it is a live
// approximation of the Host guard's audit, labeled as such in the UI.

window.__ModuleLoader__.load({
  id: 'dsh-anti-drift',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // The client Context is only visible inside apply(c); the component runs
    // later during render with no global `ctx`. Capture the sessions service
    // here so the component can reach it (this was the bug that rendered null).
    let SESSIONS = null;

    // --- fingerprint recognizers (mirror the Host guards) --------------
    const NOT_FOUND_RE = /(not found|no such file|enoent|does not exist|不存在|找不到|cannot find|未能找到)/i;
    const DONE_CLAIM_RE = /(已完成|已创建|已修改|已修复|已部署|已删除|已生成|已写入|已运行|成功创建|成功修改|成功部署|done|completed|created|modified|fixed|deployed|deleted|implemented|generated|written|applied the (fix|change))/i;
    const CIRCLES_WINDOW = 12; // look back this many tool calls for repeats

    function textOf(message) {
      if (!message || !Array.isArray(message.content)) return '';
      let out = '';
      for (const b of message.content) {
        if (b && b.type === 'text' && typeof b.text === 'string') out += b.text + '\n';
      }
      return out;
    }

    function sigOf(name, args) {
      let a = '';
      try {
        a = typeof args === 'string' ? args : JSON.stringify(args ?? null);
      } catch {
        a = String(args);
      }
      if (a.length > 200) a = a.slice(0, 200);
      return name + '\u0000' + a;
    }

    // Fold one session event window into a fingerprint.
    function fold(entries) {
      let notFound = 0; // tool failures saying "does not exist"
      let doneClaims = 0; // assistant "done" claims
      let effectful = 0; // successful tool results (approx evidence)
      const callSigs = [];
      let repeatPeeks = 0; // extra repeats seen within the window

      for (const entry of entries || []) {
        if (!entry || entry.type !== 'event') continue;
        const ev = entry.event;
        if (!ev || !ev.type) continue;
        if (ev.type === 'tool/call') {
          const d = ev.data || {};
          callSigs.push(sigOf(d.name, d.arguments));
        } else if (ev.type === 'tool/result') {
          const d = ev.data || {};
          const msg = d.message || {};
          const err = d.error;
          if (err || msg.isError) {
            const txt = (err && (err.reason || err.code || err.name)) || '';
            if (NOT_FOUND_RE.test(String(txt))) notFound += 1;
          } else {
            effectful += 1;
          }
        } else if (ev.type === 'assistant/message') {
          const txt = textOf((ev.data || {}).message);
          if (txt && DONE_CLAIM_RE.test(txt)) doneClaims += 1;
        }
      }

      const tail = callSigs.slice(-CIRCLES_WINDOW);
      const counts = new Map();
      for (const s of tail) counts.set(s, (counts.get(s) || 0) + 1);
      for (const v of counts.values()) if (v > 1) repeatPeeks += v - 1;

      const bluff = effectful === 0 ? doneClaims : 0;
      return { notFound, repeats: repeatPeeks, doneClaims, bluff, effectful };
    }

    // --- component -----------------------------------------------------
    const LABELS = {
      title: '反幻觉守卫',
      notFound: '猜测失败',
      repeats: '原地打转',
      bluff: '无据声称完成',
      normal: '正常',
      approx: '本会话 · 客户端近似统计',
      none: '本会话暂无幻觉/空转信号',
    };
    const L = (k) => LABELS[k] || k;

    function Chip(props) {
      const sessionId = props && props.sessionId;
      const [stats, setStats] = React.useState(null);
      const [open, setOpen] = React.useState(false);

      React.useEffect(() => {
        const sessions = SESSIONS;
        if (!sessions || !sessionId || typeof sessions.binding !== 'function') return undefined;
        const binding = sessions.binding(sessionId);
        const src = binding && binding.eventSource;
        if (!src || typeof src.subscribe !== 'function') return undefined;

        const recompute = () => {
          try {
            const snap = src.getSnapshot();
            setStats(fold(snap && snap.entries));
          } catch {
            setStats(null);
          }
        };
        recompute();
        const dispose = src.subscribe(recompute);
        return () => {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        };
      }, [sessionId]);

      if (!stats) {
        // Not ready yet: show a quiet placeholder so it is visually obvious the
        // chip mounted (a truly missing component renders nothing at all).
        return h(
          'div',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '2px 8px',
              borderRadius: '999px',
              fontSize: '11px',
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l1)',
              userSelect: 'none',
            },
          },
          h('span', {
            style: {
              width: '7px',
              height: '7px',
              borderRadius: '999px',
              background: 'var(--dsw-alias-state-idle-primary)',
            },
          }),
          h('span', null, '反幻觉守卫：读取中…'),
        );
      }
      const { notFound, repeats, bluff } = stats;
      const total = notFound + repeats + bluff;
      const ok = total === 0;

      const color = ok
        ? 'var(--dsw-alias-state-success-primary)'
        : total >= 3
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-state-warn-primary)';

      const chipStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        lineHeight: '16px',
        color,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        cursor: 'pointer',
        userSelect: 'none',
      };

      const dotStyle = {
        width: '7px',
        height: '7px',
        borderRadius: '999px',
        background: color,
        flex: '0 0 auto',
      };

      const summary = ok
        ? L('normal')
        : `${L('notFound')} ${notFound} · ${L('repeats')} ${repeats} · ${L('bluff')} ${bluff}`;

      const detailStyle = {
        marginTop: '4px',
        padding: '6px 10px',
        borderRadius: '8px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '2px' } },
        h(
          'button',
          {
            type: 'button',
            style: chipStyle,
            title: L('approx'),
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen((v) => !v),
          },
          h('span', { style: dotStyle }),
          h('span', null, `${L('title')}：${summary}`),
        ),
        open
          ? h(
              'div',
              { style: detailStyle },
              h('div', null, L('approx')),
              ok
                ? h('div', null, L('none'))
                : h(
                    'div',
                    null,
                    `${L('notFound')}: ${notFound}｜${L('repeats')}: ${repeats}｜${L('bluff')}: ${bluff}`,
                  ),
            )
          : null,
      );
    }

    // Error boundary so a throw can never blank the host slot.
    class Guard extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        if (this.state.failed) return null;
        return this.props.children;
      }
    }

    function SafeChip(props) {
      return h(Guard, null, h(Chip, props));
    }

    return {
      inject: ['slots'],
      apply(c) {
        // Capture the sessions service for the component. The component has no
        // Context of its own at render time.
        try {
          SESSIONS = (c.get && c.get('sessions')) || c.sessions || null;
        } catch {
          SESSIONS = c.sessions || null;
        }
        if (!SESSIONS && typeof c.inject === 'function') {
          try {
            c.inject(['sessions'], (host) => {
              SESSIONS = host.sessions || SESSIONS;
            });
          } catch {
            /* ignore */
          }
        }
        c.slots.inject('conversation.composer.dock', () =>
          c.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'anti-drift-chip',
              order: 60,
              inject: (sessionId) => ({ sessionId }),
            },
            SafeChip,
          ),
        );
      },
    };
  },
});

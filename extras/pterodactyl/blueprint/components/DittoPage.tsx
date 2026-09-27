import React, { useState } from 'react';
import { ServerContext } from '@/state/server';
import ServerContentBlock from '@/components/elements/ServerContentBlock';

/**
 * A « Ditto » tab in the Pterodactyl server page, showing the bot's web dashboard.
 *
 * Ditto serves its dashboard on the server's own port, so the address is guessed
 * from the server's main allocation; it can be changed here (saved in this browser),
 * for example to an HTTPS address in front of the dashboard.
 */
export default () => {
    const uuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const allocations = ServerContext.useStoreState((state) => state.server.data!.allocations);
    const main = allocations.find((a) => a.isDefault) || allocations[0];
    const host = main ? main.alias || (main.ip === '0.0.0.0' ? window.location.hostname : main.ip) : window.location.hostname;
    const guess = main ? `http://${host}:${main.port}` : '';

    const key = `ditto-dashboard:${uuid}`;
    const [url, setUrl] = useState<string>(() => localStorage.getItem(key) || guess);
    const [draft, setDraft] = useState(url);
    const [editing, setEditing] = useState(!url);

    // A page served over HTTPS cannot show an HTTP page inside it: browsers block it.
    const blocked = window.location.protocol === 'https:' && url.startsWith('http:');

    const save = () => {
        const clean = draft.trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^\s]+$/.test(clean)) return;
        localStorage.setItem(key, clean);
        setUrl(clean);
        setEditing(false);
    };
    const reset = () => {
        localStorage.removeItem(key);
        setUrl(guess);
        setDraft(guess);
        setEditing(false);
    };

    const card: React.CSSProperties = {
        padding: 16,
        borderRadius: 10,
        background: 'rgba(0, 0, 0, 0.18)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        marginBottom: 16,
    };
    const button: React.CSSProperties = {
        padding: '8px 14px',
        borderRadius: 8,
        border: '1px solid rgba(255, 255, 255, 0.12)',
        background: 'rgba(255, 255, 255, 0.06)',
        color: 'inherit',
        cursor: 'pointer',
        fontWeight: 600,
    };
    const primary: React.CSSProperties = { ...button, background: '#7c5cff', borderColor: 'transparent', color: '#fff' };

    return (
        <ServerContentBlock title={'Ditto'}>
            <div style={card}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ fontWeight: 700, fontSize: 16 }}>Ditto dashboard</div>
                        <div style={{ opacity: 0.7, fontSize: 13, wordBreak: 'break-all' }}>{url || 'No address yet'}</div>
                    </div>
                    {url && (
                        <a href={url} target={'_blank'} rel={'noopener noreferrer'} style={{ ...primary, textDecoration: 'none' }}>
                            Open in a new tab
                        </a>
                    )}
                    <button style={button} onClick={() => setEditing(!editing)}>
                        Change address
                    </button>
                </div>
                {editing && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                        <input
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder={'https://ditto.example.com'}
                            style={{ ...button, flex: 1, minWidth: 220, cursor: 'text', fontWeight: 400 }}
                        />
                        <button style={primary} onClick={save}>
                            Save
                        </button>
                        <button style={button} onClick={reset}>
                            Use the server port
                        </button>
                    </div>
                )}
            </div>
            {url && !blocked && (
                <iframe
                    src={url}
                    title={'Ditto dashboard'}
                    style={{ width: '100%', height: '78vh', border: 0, borderRadius: 10, background: '#0a0d16' }}
                />
            )}
            {url && blocked && (
                <div style={card}>
                    This panel uses HTTPS and the dashboard address is HTTP, so the browser will not show it inside the
                    panel. Use <b>Open in a new tab</b>, or put the dashboard behind HTTPS (a reverse proxy or a
                    Cloudflare Tunnel), set <code>DASHBOARD_URL</code> and <code>DASHBOARD_FRAME_ANCESTORS</code> in
                    Ditto’s <code>.env</code>, and save that address here.
                </div>
            )}
        </ServerContentBlock>
    );
};

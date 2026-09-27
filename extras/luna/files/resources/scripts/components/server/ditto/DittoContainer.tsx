import React, { useCallback, useEffect, useRef, useState } from 'react';
import tw from 'twin.macro';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    faBolt,
    faHeadphones,
    faHome,
    faRobot,
    faScroll,
    faShieldAlt,
    faSignOutAlt,
    faSlidersH,
    faSync,
    faVolumeUp,
} from '@fortawesome/free-solid-svg-icons';
import { ServerContext } from '@/state/server';
import ServerContentBlock from '@/components/elements/ServerContentBlock';
import Spinner from '@/components/elements/Spinner';
import Button from '@/components/elements/Button';
import Input from '@/components/elements/Input';
import Select from '@/components/elements/Select';
import FlashMessageRender from '@/components/FlashMessageRender';
import useFlash from '@/plugins/useFlash';
import ditto, { DittoError, DittoGuild, DittoLive, DittoMe, setDittoToken } from '@/api/server/ditto';
import { Avatar, Card, CardTitle, Muted, Pill, Row, Tab, Tabs, formatUptime } from './ui';
import { CaptchaTab, LogsTab, MusicTab, OverviewTab, SettingsTab, VoiceTab } from './DittoTabs';

/**
 * Ditto addon: the Ditto Discord bot's dashboard as a tab of the server, drawn with
 * the panel's own theme. The bot runs on this server; the panel forwards the page's
 * requests to it.
 */

type TabId = 'overview' | 'captcha' | 'music' | 'voice' | 'settings' | 'logs';
const TABS: { id: TabId; label: string; icon: typeof faHome }[] = [
    { id: 'overview', label: 'Overview', icon: faHome },
    { id: 'captcha', label: 'Captcha', icon: faShieldAlt },
    { id: 'music', label: 'Music', icon: faHeadphones },
    { id: 'voice', label: 'Voice', icon: faVolumeUp },
    { id: 'settings', label: 'Settings', icon: faSlidersH },
    { id: 'logs', label: 'Logs', icon: faScroll },
];

export interface DittoActions {
    save: (field: string, values: string[]) => Promise<void>;
    run: (action: 'quick-setup' | 'detect' | 'panel') => Promise<void>;
    music: (action: string, body?: Record<string, unknown>) => Promise<void>;
    unlock: (channelId: string) => Promise<void>;
}

const remember = (key: string, value?: string) => {
    try {
        if (value === undefined) return localStorage.getItem(key);
        localStorage.setItem(key, value);
    } catch {
        /* private mode */
    }
    return null;
};

const Login = ({ uuid, onDone, notice }: { uuid: string; onDone: () => void; notice?: string }) => {
    const [useCode, setUseCode] = useState(false);
    const [value, setValue] = useState('');
    const [error, setError] = useState(notice ?? '');
    const [busy, setBusy] = useState(false);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        ditto<{ token: string }>(
            uuid,
            'post',
            useCode ? 'login/link' : 'login',
            useCode ? { code: value.trim() } : { password: value }
        )
            .then(({ token }) => {
                setDittoToken(uuid, token);
                onDone();
            })
            .catch((err: DittoError) => setError(err.message))
            .then(() => setBusy(false));
    };

    return (
        <Card css={tw`max-w-md mx-auto mt-8`}>
            <CardTitle>
                <FontAwesomeIcon icon={faRobot} /> Log in to Ditto
            </CardTitle>
            <p css={tw`mb-4 text-sm`}>
                <Muted>
                    {useCode
                        ? 'Type /dashboard in Discord and paste the code from its link.'
                        : 'The admin password is printed in this server’s console when Ditto starts.'}
                </Muted>
            </p>
            <form onSubmit={submit}>
                <Input
                    type={useCode ? 'text' : 'password'}
                    value={value}
                    placeholder={useCode ? 'Login code' : 'Admin password'}
                    onChange={(e) => setValue(e.currentTarget.value)}
                    autoFocus
                    required
                />
                {error && <p css={tw`mt-2 text-sm text-red-400`}>{error}</p>}
                <Row css={tw`mt-4 justify-between`}>
                    <button
                        type={'button'}
                        css={tw`text-sm`}
                        style={{ color: 'var(--color-primary)' }}
                        onClick={() => setUseCode(!useCode)}
                    >
                        {useCode ? 'Use the admin password' : 'Use a code from /dashboard'}
                    </button>
                    <Button type={'submit'} isLoading={busy}>
                        Log in
                    </Button>
                </Row>
            </form>
        </Card>
    );
};

export default () => {
    const uuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const { addFlash, clearFlashes } = useFlash();

    const [state, setState] = useState<'loading' | 'login' | 'ready' | 'down'>('loading');
    const [problem, setProblem] = useState('');
    const [me, setMe] = useState<DittoMe | null>(null);
    const [guildId, setGuildId] = useState<string | null>(remember(`ditto:guild:${uuid}`));
    const [guild, setGuild] = useState<DittoGuild | null>(null);
    const [tab, setTab] = useState<TabId>((remember('ditto:tab') as TabId) || 'overview');
    const live = useRef<number>();

    const flash = (message: string, type: 'success' | 'error' = 'success') => {
        clearFlashes('ditto');
        addFlash({ key: 'ditto', type, message });
    };

    const fail = useCallback(
        (err: DittoError) => {
            if (err.status === 401) {
                setDittoToken(uuid, null);
                setState('login');
            } else if (err.code === 'unreachable' || err.code === 'not_ditto') {
                setProblem(err.message);
                setState('down');
            } else flash(err.message, 'error');
        },
        [uuid]
    );

    const loadGuild = useCallback(
        (id: string) => ditto<DittoGuild>(uuid, 'get', `guilds/${id}`).then(setGuild).catch(fail),
        [uuid]
    );

    const load = useCallback(() => {
        setState('loading');
        ditto<DittoMe>(uuid, 'get', 'me')
            .then((data) => {
                setMe(data);
                setState('ready');
                const id = data.guilds.some((g) => g.id === guildId) ? guildId : data.guilds[0]?.id ?? null;
                setGuildId(id);
                if (id) return loadGuild(id);
                return undefined;
            })
            .catch(fail);
    }, [uuid, guildId]);

    useEffect(load, [uuid]);

    // Music and logs change on their own: fetch them every few seconds.
    useEffect(() => {
        if (state !== 'ready' || !guildId) return undefined;
        live.current = window.setInterval(() => {
            if (document.hidden) return;
            ditto<DittoLive>(uuid, 'get', `guilds/${guildId}/live`)
                .then((data) =>
                    setGuild((g) => (g && g.id === guildId ? { ...g, music: data.music, logs: data.logs } : g))
                )
                .catch(() => undefined);
        }, 4000);
        return () => window.clearInterval(live.current);
    }, [state, guildId, uuid]);

    const pick = (id: string) => {
        remember(`ditto:guild:${uuid}`, id);
        setGuildId(id);
        setGuild(null);
        loadGuild(id);
    };

    const actions: DittoActions = {
        save: (field, values) =>
            ditto(uuid, 'patch', `guilds/${guildId}/config`, { field, values })
                .then(() => loadGuild(guildId!))
                .then(() => flash('Saved.'))
                .catch(fail),
        run: (action) =>
            ditto<any>(uuid, 'post', `guilds/${guildId}/actions/${action}`)
                .then((r) => {
                    if (action === 'quick-setup')
                        flash(`Done: ${r.created.length} created, ${r.hidden} channel(s) hidden from newcomers.`);
                    else if (action === 'detect')
                        flash(r.filled.length ? `Filled ${r.filled.length} setting(s).` : 'Nothing new found.');
                    else
                        flash(
                            r.posted ? 'Verify panel posted.' : 'There is no verification channel yet.',
                            r.posted ? 'success' : 'error'
                        );
                    return loadGuild(guildId!);
                })
                .catch(fail),
        music: (action, body) =>
            ditto<any>(uuid, 'post', `guilds/${guildId}/music/${action}`, body ?? {})
                .then((r) => {
                    if (action === 'play')
                        flash(
                            r.added > 1
                                ? `Added ${r.added} tracks.`
                                : r.position === 0
                                ? 'Playing.'
                                : `Added — #${r.position} in the queue.`
                        );
                    window.setTimeout(() => loadGuild(guildId!), action === 'play' ? 1500 : 300);
                })
                .catch(fail),
        unlock: (channelId) =>
            ditto(uuid, 'delete', `guilds/${guildId}/locks/${channelId}`)
                .then(() => loadGuild(guildId!))
                .then(() => flash('Unlocked.'))
                .catch(fail),
    };

    const logout = () => {
        ditto(uuid, 'post', 'logout').catch(() => undefined);
        setDittoToken(uuid, null);
        setMe(null);
        setGuild(null);
        setState('login');
    };

    return (
        <ServerContentBlock title={'Ditto'}>
            <FlashMessageRender byKey={'ditto'} css={tw`mb-4`} />
            {state === 'loading' && <Spinner size={'large'} centered />}
            {state === 'login' && <Login uuid={uuid} onDone={load} />}
            {state === 'down' && (
                <Card css={tw`max-w-xl mx-auto mt-8 text-center`}>
                    <CardTitle css={tw`justify-center`}>
                        <FontAwesomeIcon icon={faRobot} /> Ditto is not answering
                    </CardTitle>
                    <p css={tw`mb-2 text-sm`} style={{ color: 'var(--color-base)' }}>
                        {problem}
                    </p>
                    <p css={tw`mb-4 text-sm`}>
                        <Muted>Start the server, wait for “[dashboard] open …” in the console, then try again.</Muted>
                    </p>
                    <Button onClick={load}>
                        <FontAwesomeIcon icon={faSync} css={tw`mr-2`} />
                        Try again
                    </Button>
                </Card>
            )}
            {state === 'ready' && me && (
                <>
                    <Row css={tw`mb-4`}>
                        <Avatar url={me.bot.avatar} name={me.bot.name} size={44} />
                        <div css={tw`mr-auto`}>
                            <div css={tw`text-lg font-bold`} style={{ color: 'var(--color-base)' }}>
                                {me.bot.name}
                            </div>
                            <Muted css={tw`text-xs`}>
                                v{me.bot.version} · up {formatUptime(me.bot.uptime)} · {me.bot.ping} ms
                            </Muted>
                        </div>
                        <Pill $tone={me.bot.music ? 'good' : 'bad'}>
                            {me.bot.music ? 'Music ready' : 'Music starting'}
                        </Pill>
                        <Pill>{me.bot.photos} captcha photos</Pill>
                        {me.guilds.length > 1 && (
                            <div css={tw`w-56`}>
                                <Select value={guildId ?? ''} onChange={(e) => pick(e.currentTarget.value)}>
                                    {me.guilds.map((g) => (
                                        <option key={g.id} value={g.id}>
                                            {g.name}
                                        </option>
                                    ))}
                                </Select>
                            </div>
                        )}
                        <Button color={'grey'} size={'xsmall'} onClick={logout} title={'Log out of Ditto'}>
                            <FontAwesomeIcon icon={faSignOutAlt} />
                        </Button>
                    </Row>
                    {!me.guilds.length ? (
                        <Card>
                            <Muted>Ditto is in no Discord server you can manage yet.</Muted>
                        </Card>
                    ) : !guild ? (
                        <Spinner size={'large'} centered />
                    ) : (
                        <>
                            <Tabs>
                                {TABS.map((t) => (
                                    <Tab
                                        key={t.id}
                                        $active={tab === t.id}
                                        onClick={() => {
                                            remember('ditto:tab', t.id);
                                            setTab(t.id);
                                        }}
                                    >
                                        <FontAwesomeIcon icon={t.icon} />
                                        {t.label}
                                    </Tab>
                                ))}
                            </Tabs>
                            {guild.warnings.map((w) => (
                                <Card
                                    key={w}
                                    css={tw`mb-4 text-sm`}
                                    style={{ borderColor: '#f59e0b', color: '#f59e0b' }}
                                >
                                    <FontAwesomeIcon icon={faBolt} css={tw`mr-2`} />
                                    {w}
                                </Card>
                            ))}
                            {tab === 'overview' && <OverviewTab guild={guild} actions={actions} />}
                            {tab === 'captcha' && <CaptchaTab guild={guild} actions={actions} />}
                            {tab === 'music' && <MusicTab guild={guild} actions={actions} />}
                            {tab === 'voice' && <VoiceTab guild={guild} actions={actions} />}
                            {tab === 'settings' && <SettingsTab guild={guild} actions={actions} />}
                            {tab === 'logs' && <LogsTab guild={guild} />}
                        </>
                    )}
                </>
            )}
        </ServerContentBlock>
    );
};

import React, { useEffect, useState } from 'react';
import tw from 'twin.macro';
import { useLocation } from 'react-router';
import { Redirect } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faRobot, faSignOutAlt, faSync } from '@fortawesome/free-solid-svg-icons';
import { ServerContext } from '@/state/server';
import ServerContentBlock from '@/components/elements/ServerContentBlock';
import FlashMessageRender from '@/components/FlashMessageRender';
import Spinner from '@/components/elements/Spinner';
import Input from '@/components/elements/Input';
import Select from '@/components/elements/Select';
import { Button } from '@/components/elements/button/index';
import { Alert } from '@/components/elements/alert';
import useFlash from '@/plugins/useFlash';
import { DittoError } from '@/api/server/ditto';
import { DittoStore, useDitto } from './store';
import { Avatar, Box, Card, CardBody, Dot, Muted, formatUptime } from './ui';
import { Captcha, Logs, Music, Overview, SectionProps, Settings, Voice } from './sections';

/**
 * Ditto addon: the pages of the Ditto section of a server, one per entry of the
 * « Ditto » group in Luna's sidebar. The Ditto Discord bot runs on this server; the
 * panel logs in to it and forwards the pages' requests.
 */

const SECTIONS: Record<string, { title: string; Page: (props: SectionProps) => JSX.Element }> = {
    overview: { title: 'Overview', Page: Overview },
    captcha: { title: 'Captcha', Page: Captcha },
    music: { title: 'Music', Page: Music },
    voice: { title: 'Voice', Page: Voice },
    settings: { title: 'Bot settings', Page: Settings },
    logs: { title: 'Logs', Page: Logs },
};

const Login = ({ store }: { store: DittoStore }) => {
    const [useCode, setUseCode] = useState(false);
    const [value, setValue] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        store
            .login(value, useCode)
            .catch((err: DittoError) => setError(err.message))
            .then(() => setBusy(false));
    };

    return (
        <Box icon={faRobot} title={'Log in to Ditto'} css={tw`max-w-lg mx-auto mt-6`}>
            <p css={tw`mb-4 text-sm leading-relaxed`}>
                <Muted>
                    {useCode
                        ? 'Type /dashboard in Discord and paste the code from the link Ditto sends you.'
                        : 'The panel could not log you in by itself (it needs Ditto 0.6 or later). Use the admin password Ditto prints in the console when it starts.'}
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
                <div css={tw`flex flex-wrap items-center justify-between gap-2 mt-4`}>
                    <button
                        type={'button'}
                        css={tw`text-sm`}
                        style={{ color: 'var(--color-primary)' }}
                        onClick={() => setUseCode(!useCode)}
                    >
                        {useCode ? 'Use the admin password' : 'Use a code from /dashboard'}
                    </button>
                    <Button type={'submit'} disabled={busy || !value}>
                        {busy ? 'Logging in…' : 'Log in'}
                    </Button>
                </div>
            </form>
        </Box>
    );
};

const Down = ({ store }: { store: DittoStore }) => (
    <Card css={tw`max-w-xl mx-auto mt-6 text-center`}>
        <CardBody css={tw`flex flex-col items-center gap-3 py-10`}>
            <span
                css={tw`flex items-center justify-center w-14 h-14 text-2xl rounded-full`}
                style={{ backgroundColor: 'var(--color-neutral)', color: 'var(--color-muted)' }}
            >
                <FontAwesomeIcon icon={faRobot} />
            </span>
            <h2 css={tw`text-lg font-medium`} style={{ color: 'var(--color-base)' }}>
                Ditto is not answering
            </h2>
            <p css={tw`text-sm`} style={{ color: 'var(--color-base)' }}>
                {store.state.problem}
            </p>
            <p css={tw`max-w-md text-sm`}>
                <Muted>
                    Start the server and wait for « [dashboard] open … » in the console. This page tries again by
                    itself.
                </Muted>
            </p>
            <Button onClick={() => store.load()} css={tw`mt-2`}>
                <FontAwesomeIcon icon={faSync} css={tw`mr-2`} />
                Try again
            </Button>
        </CardBody>
    </Card>
);

const Header = ({ store, title }: { store: DittoStore; title: string }) => {
    const { me, guildId, manual } = store.state;
    if (!me) return null;
    const current = me.guilds.find((g) => g.id === guildId);
    return (
        <div css={tw`flex flex-wrap items-center gap-4 mb-6`}>
            <Avatar url={me.bot.avatar} name={me.bot.name} size={48} />
            <div css={tw`flex-1 min-w-0`}>
                <h1
                    css={tw`text-2xl font-medium leading-tight truncate font-header`}
                    style={{ color: 'var(--color-base)' }}
                >
                    {title}
                </h1>
                <div css={tw`flex flex-wrap items-center gap-2 mt-1 text-sm`} style={{ color: 'var(--color-muted)' }}>
                    <Dot on />
                    <span>
                        {me.bot.name}
                        {current && me.guilds.length === 1 ? (
                            <>
                                {' '}
                                on <b style={{ color: 'var(--color-base)' }}>{current.name}</b>
                            </>
                        ) : null}
                    </span>
                    <span>·</span>
                    <span>up {formatUptime(me.bot.uptime)}</span>
                    <span>·</span>
                    <span>{me.bot.ping} ms</span>
                    <span>·</span>
                    <span>v{me.bot.version}</span>
                </div>
            </div>
            {me.guilds.length > 1 && (
                <div style={{ width: 240 }} title={'Discord server'}>
                    <Select value={guildId ?? ''} onChange={(e) => store.pick(e.currentTarget.value)}>
                        {me.guilds.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.name}
                            </option>
                        ))}
                    </Select>
                </div>
            )}
            {manual && (
                <Button.Text
                    size={Button.Sizes.Small}
                    onClick={store.logout}
                    title={'Log out of Ditto in this browser'}
                >
                    <FontAwesomeIcon icon={faSignOutAlt} css={tw`mr-2`} />
                    Log out
                </Button.Text>
            )}
        </div>
    );
};

export default () => {
    const uuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const id = ServerContext.useStoreState((state) => state.server.data!.id);
    const { pathname } = useLocation();
    const { addFlash, clearFlashes } = useFlash();
    const store = useDitto(uuid);
    const { status, me, guild } = store.state;

    const key = /\/ditto\/([a-z]+)\/?$/.exec(pathname)?.[1] ?? 'overview';
    const section = SECTIONS[key] ?? SECTIONS.overview;

    store.notify = (message, type = 'success') => {
        clearFlashes('ditto');
        addFlash({ key: 'ditto', type, message });
        if (type === 'success') window.setTimeout(() => clearFlashes('ditto'), 3000);
    };

    useEffect(() => () => clearFlashes('ditto'), []);

    // While Ditto is down, look again now and then: it comes back on its own after a restart.
    useEffect(() => {
        if (status !== 'down') return undefined;
        const timer = window.setInterval(() => !document.hidden && store.load(true), 10000);
        return () => window.clearInterval(timer);
    }, [status]);

    const link = (to: string) => `/server/${id}/ditto/${to}`;
    const { Page } = section;

    // /ditto alone: the overview, at the address its sidebar entry points to.
    if (/\/ditto\/?$/.test(pathname)) return <Redirect to={link('overview')} />;

    return (
        <ServerContentBlock title={`Ditto · ${section.title}`}>
            <FlashMessageRender byKey={'ditto'} css={tw`mb-4`} />
            {status === 'loading' && <Spinner size={'large'} centered />}
            {status === 'login' && <Login store={store} />}
            {status === 'down' && <Down store={store} />}
            {status === 'ready' && me && (
                <>
                    <Header store={store} title={key === 'overview' ? me.bot.name : section.title} />
                    {!me.guilds.length ? (
                        <Card>
                            <CardBody css={tw`flex flex-col items-center gap-4 py-10 text-sm text-center`}>
                                <Muted>Ditto is not in any Discord server you can manage yet.</Muted>
                                {me.bot.invite && (
                                    <a href={me.bot.invite} target={'_blank'} rel={'noopener noreferrer'}>
                                        <Button>
                                            <FontAwesomeIcon icon={faPlus} css={tw`mr-2`} />
                                            Add Ditto to a Discord server
                                        </Button>
                                    </a>
                                )}
                            </CardBody>
                        </Card>
                    ) : !guild ? (
                        <Spinner size={'large'} centered />
                    ) : (
                        <>
                            {guild.warnings.map((w) => (
                                <Alert key={w} type={'warning'} className={'mb-4'}>
                                    {w}
                                </Alert>
                            ))}
                            <Page store={store} guild={guild} link={link} />
                        </>
                    )}
                </>
            )}
        </ServerContentBlock>
    );
};

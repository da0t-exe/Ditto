import React, { useEffect, useState } from 'react';
import tw from 'twin.macro';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    IconDefinition,
    faArrowRight,
    faBolt,
    faChartBar,
    faCheck,
    faClipboardCheck,
    faCog,
    faHeadphones,
    faHistory,
    faListOl,
    faLock,
    faMusic,
    faPause,
    faPlay,
    faPlus,
    faRandom,
    faSearch,
    faShieldAlt,
    faStepBackward,
    faStepForward,
    faStop,
    faStream,
    faThumbtack,
    faTimes,
    faTrash,
    faUnlock,
    faUserCheck,
    faUserClock,
    faUserPlus,
    faUserShield,
    faUserTimes,
    faUsers,
    faVolumeUp,
} from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/elements/button/index';
import { Dialog } from '@/components/elements/dialog';
import Input from '@/components/elements/Input';
import Select from '@/components/elements/Select';
import StatBlock from '@/components/server/console/StatBlock';
import { DittoCaptchaEvent, DittoGuild } from '@/api/server/ditto';
import type { DittoStore } from './store';
import {
    Box,
    Card,
    CardBody,
    DiscordText,
    Empty,
    Field,
    Line,
    Muted,
    MultiSelect,
    NumberSelect,
    Picture,
    SingleSelect,
    Toggle,
    formatTime,
    timeAgo,
} from './ui';

/* Ditto addon: the content of each Ditto page. Every setting is saved as soon as it changes. */

export interface SectionProps {
    store: DittoStore;
    guild: DittoGuild;
    /** The panel address of another Ditto page. */
    link: (section: string) => string;
}

const Stats = ({ children }: { children: React.ReactNode }) => (
    <div css={tw`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4`}>{children}</div>
);

const Columns = ({ children }: { children: React.ReactNode }) => (
    <div css={tw`grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 items-start`}>{children}</div>
);

const Small = Button.Sizes.Small;

// ---------- Tools ----------

const Tools = ({ store }: { store: DittoStore }) => {
    const [confirm, setConfirm] = useState(false);
    return (
        <div css={tw`flex flex-wrap gap-2`}>
            <Dialog.Confirm
                open={confirm}
                onClose={() => setConfirm(false)}
                title={'Run the quick setup?'}
                confirm={'Set it up'}
                onConfirmed={() => {
                    setConfirm(false);
                    store.run('quick-setup');
                }}
            >
                Ditto creates what is missing (an Unverified role, #verify and #ditto-logs), hides the other channels
                from Unverified and posts the Verify panel. Members already here keep their access; delete the
                Unverified role to undo it.
            </Dialog.Confirm>
            <Button size={Small} onClick={() => setConfirm(true)}>
                <FontAwesomeIcon icon={faBolt} css={tw`mr-2`} />
                Quick setup
            </Button>
            <Button.Text
                size={Small}
                onClick={() => store.run('detect')}
                title={'Fill empty settings from your role and channel names'}
            >
                <FontAwesomeIcon icon={faSearch} css={tw`mr-2`} />
                Auto-detect
            </Button.Text>
            <Button.Text size={Small} onClick={() => store.run('panel')} title={'Post the Verify panel again'}>
                <FontAwesomeIcon icon={faThumbtack} css={tw`mr-2`} />
                Post the panel
            </Button.Text>
        </div>
    );
};

const LogLines = ({ guild, lines }: { guild: DittoGuild; lines: DittoGuild['logs'] }) => (
    <div>
        {lines.map((l, k) => (
            <Line key={`${l.at}-${k}`} css={tw`items-start text-sm`}>
                <Muted css={tw`flex-none w-20 text-xs`} style={{ fontVariantNumeric: 'tabular-nums', paddingTop: 2 }}>
                    {new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Muted>
                <span css={tw`min-w-0 break-words`} style={{ color: 'var(--color-base)' }}>
                    <DiscordText text={l.text} guild={guild} />
                </span>
            </Line>
        ))}
    </div>
);

// ---------- Overview ----------

const Shortcut = ({ to, icon, title, text }: { to: string; icon: IconDefinition; title: string; text: string }) => (
    <Link
        to={to}
        css={tw`flex items-center gap-4 p-4 no-underline transition-all duration-150`}
        style={{
            backgroundColor: 'var(--color-background-secondary)',
            border: '1px solid var(--color-neutral)',
            borderRadius: 'var(--border-radius, 8px)',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-primary)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-neutral)')}
    >
        <span
            css={tw`flex items-center justify-center flex-none w-10 h-10 rounded-full`}
            style={{ backgroundColor: 'var(--color-neutral)', color: 'var(--color-base)' }}
        >
            <FontAwesomeIcon icon={icon} />
        </span>
        <span css={tw`min-w-0`}>
            <span css={tw`block font-medium`} style={{ color: 'var(--color-base)' }}>
                {title}
            </span>
            <Muted css={tw`block text-xs truncate`}>{text}</Muted>
        </span>
        <FontAwesomeIcon icon={faArrowRight} css={tw`ml-auto`} style={{ color: 'var(--color-muted)' }} />
    </Link>
);

export const Overview = ({ store, guild, link }: SectionProps) => {
    const c = guild.config;
    const t = guild.captcha.totals;
    const m = guild.music;
    const checks: { ok: boolean; name: string; text: string; section: string }[] = [
        {
            ok: guild.verification,
            name: 'Captcha',
            text: guild.verification
                ? 'Newcomers verify before they see the server'
                : 'Not set up yet: Quick setup does it in one click',
            section: 'captcha',
        },
        {
            ok: c.staffRoles.length > 0,
            name: 'Staff roles',
            text: c.staffRoles.length
                ? `${c.staffRoles.length} role(s) can use Ditto`
                : 'Only admins and the owner can use Ditto',
            section: 'settings',
        },
        {
            ok: !!c.logChannel,
            name: 'Log channel',
            text: c.logChannel ? 'Joins, captcha and moderation are logged' : 'Nothing is logged in Discord',
            section: 'settings',
        },
        {
            ok: c.rooms.length > 0,
            name: 'Rooms',
            text: c.rooms.length ? `${c.rooms.length} room(s) reset when empty` : 'Optional',
            section: 'voice',
        },
    ];
    const done = checks.filter((x) => x.ok).length;
    return (
        <>
            <Stats>
                <StatBlock icon={faUsers} title={'Members'}>
                    {guild.members.toLocaleString()}
                </StatBlock>
                <StatBlock icon={faUserCheck} title={'Verified · 14 days'}>
                    {t.pass}
                </StatBlock>
                <StatBlock icon={faUserTimes} title={'Missed · 14 days'}>
                    {t.fail}
                    {t.lockout > 0 && <Muted css={tw`ml-1 font-normal`}>({t.lockout} timed out)</Muted>}
                </StatBlock>
                <StatBlock icon={faMusic} title={'Music'} color={m?.current && !m.paused ? 'bg-green-500' : undefined}>
                    {m?.current ? m.current.title : 'Nothing playing'}
                </StatBlock>
            </Stats>
            <Columns>
                <Box
                    icon={faClipboardCheck}
                    title={'Setup'}
                    actions={
                        <Muted css={tw`text-sm`}>
                            {done} / {checks.length}
                        </Muted>
                    }
                >
                    <div css={tw`mb-4`}>
                        {checks.map((x) => (
                            <Line key={x.name}>
                                <span
                                    css={tw`flex items-center justify-center flex-none w-6 h-6 text-xs rounded-full`}
                                    style={{
                                        backgroundColor: x.ok ? '#22c55e' : 'transparent',
                                        border: x.ok ? 'none' : '2px solid var(--color-neutral)',
                                        color: '#fff',
                                    }}
                                >
                                    {x.ok && <FontAwesomeIcon icon={faCheck} />}
                                </span>
                                <div css={tw`min-w-0`}>
                                    <div css={tw`text-sm font-medium`} style={{ color: 'var(--color-base)' }}>
                                        {x.name}
                                    </div>
                                    <Muted css={tw`block text-xs`}>{x.text}</Muted>
                                </div>
                                {!x.ok && (
                                    <Link
                                        to={link(x.section)}
                                        css={tw`ml-auto text-xs whitespace-nowrap`}
                                        style={{ color: 'var(--color-primary)' }}
                                    >
                                        Set up
                                    </Link>
                                )}
                            </Line>
                        ))}
                    </div>
                    <Tools store={store} />
                </Box>
                <Box
                    icon={faHistory}
                    title={'Recent activity'}
                    actions={
                        <Link to={link('logs')} css={tw`text-sm`} style={{ color: 'var(--color-primary)' }}>
                            See all
                        </Link>
                    }
                >
                    {guild.logs.length ? (
                        <LogLines guild={guild} lines={[...guild.logs].reverse().slice(0, 7)} />
                    ) : (
                        <Empty icon={faStream}>Nothing has happened since Ditto started.</Empty>
                    )}
                </Box>
            </Columns>
            <div css={tw`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3`}>
                <Shortcut to={link('captcha')} icon={faShieldAlt} title={'Captcha'} text={'Checks and results'} />
                <Shortcut
                    to={link('music')}
                    icon={faHeadphones}
                    title={'Music'}
                    text={m?.current ? `${m.paused ? 'Paused' : 'Playing'}: ${m.current.title}` : 'Play something'}
                />
                <Shortcut
                    to={link('voice')}
                    icon={faVolumeUp}
                    title={'Voice'}
                    text={guild.locks.length ? `${guild.locks.length} locked channel(s)` : 'Rooms, locks and AFK'}
                />
                <Shortcut to={link('settings')} icon={faCog} title={'Settings'} text={'Roles, channels and logs'} />
            </div>
        </>
    );
};

// ---------- Captcha ----------

const SERIES: [DittoCaptchaEvent, string, string][] = [
    ['pass', '#22c55e', 'Passed'],
    ['fail', '#ef4444', 'Missed'],
    ['lockout', '#f59e0b', 'Timed out'],
];

const Chart = ({ guild }: { guild: DittoGuild }) => {
    const days: string[] = [];
    for (let k = 13; k >= 0; k--) days.push(new Date(Date.now() - k * 864e5).toISOString().slice(0, 10));
    const by: Record<string, number> = {};
    for (const r of guild.captcha.days) by[`${r.day}:${r.event}`] = r.n;
    const total = (d: string) => SERIES.reduce((s, [e]) => s + (by[`${d}:${e}`] || 0), 0);
    const max = Math.max(1, ...days.map(total));
    return (
        <div>
            <div css={tw`flex items-end gap-1`} style={{ height: 150 }}>
                {days.map((d) => (
                    <div
                        key={d}
                        title={`${new Date(d).toLocaleDateString()}: ${SERIES.map(
                            ([e, , l]) => `${l} ${by[`${d}:${e}`] || 0}`
                        ).join(', ')}`}
                        css={tw`flex flex-col-reverse flex-1 h-full overflow-hidden`}
                        style={{ backgroundColor: 'var(--color-background)', borderRadius: 4, gap: 1 }}
                    >
                        {SERIES.map(([e, color]) => {
                            const n = by[`${d}:${e}`] || 0;
                            return n ? (
                                <div key={e} style={{ height: `${(n / max) * 100}%`, backgroundColor: color }} />
                            ) : null;
                        })}
                    </div>
                ))}
            </div>
            <div css={tw`flex justify-between mt-2 text-xs`}>
                <Muted>{new Date(days[0]).toLocaleDateString([], { day: 'numeric', month: 'short' })}</Muted>
                <Muted>Today</Muted>
            </div>
            <div css={tw`flex flex-wrap gap-4 mt-3 text-xs`}>
                {SERIES.map(([e, color, l]) => (
                    <Muted key={e} css={tw`flex items-center gap-2`}>
                        <span css={tw`inline-block w-2 h-2 rounded-sm`} style={{ backgroundColor: color }} />
                        {l}
                    </Muted>
                ))}
            </div>
        </div>
    );
};

const EVENT: Record<DittoCaptchaEvent, [string, string]> = {
    join: ['joined', 'var(--color-muted)'],
    pass: ['passed the captcha', '#22c55e'],
    fail: ['missed the captcha', '#ef4444'],
    lockout: ['was timed out', '#f59e0b'],
    quarantine: ['was quarantined', '#a855f7'],
};

const CaptchaSettings = ({ store, guild }: { store: DittoStore; guild: DittoGuild }) => {
    const c = guild.config;
    const o = guild.options;
    return (
        <>
            <Field label={'Pending role'} hint={'Held by newcomers until they pass. Hide your channels from it.'}>
                <SingleSelect options={o.roles} value={c.pendingRole} onChange={(v) => store.save('pendingRole', v)} />
            </Field>
            <Field
                label={'Member role (optional)'}
                hint={'Given after the captcha, if your channels are opened to a role.'}
            >
                <SingleSelect options={o.roles} value={c.memberRole} onChange={(v) => store.save('memberRole', v)} />
            </Field>
            <Field
                label={'Verification channel'}
                hint={'The only channel newcomers see. Ditto posts the Verify panel there.'}
            >
                <SingleSelect
                    options={o.textChannels}
                    value={c.verifyChannel}
                    onChange={(v) => store.save('verifyChannel', v)}
                />
            </Field>
            <div css={tw`grid grid-cols-1 sm:grid-cols-2 gap-4`}>
                <Field label={'Attempts'}>
                    <NumberSelect
                        choices={[3, 4, 5, 6]}
                        value={c.captchaAttempts}
                        format={(n) => `${n} attempts`}
                        onChange={(v) => store.save('captchaAttempts', v)}
                    />
                </Field>
                <Field label={'Pause after the last miss'}>
                    <NumberSelect
                        choices={[5, 10, 30, 60]}
                        value={c.captchaTimeoutMinutes}
                        format={(n) => `${n} minutes`}
                        onChange={(v) => store.save('captchaTimeoutMinutes', v)}
                    />
                </Field>
            </div>
        </>
    );
};

export const Captcha = ({ store, guild }: SectionProps) => {
    const t = guild.captcha.totals;
    return (
        <>
            <Stats>
                <StatBlock icon={faUserPlus} title={'Joined · 14 days'}>
                    {t.join}
                </StatBlock>
                <StatBlock icon={faUserCheck} title={'Passed'}>
                    {t.pass}
                </StatBlock>
                <StatBlock icon={faUserTimes} title={'Missed'}>
                    {t.fail}
                </StatBlock>
                <StatBlock icon={faUserShield} title={'Quarantined'}>
                    {t.quarantine}
                </StatBlock>
            </Stats>
            <Columns>
                <Box icon={faChartBar} title={'Last 14 days'}>
                    <Chart guild={guild} />
                </Box>
                <Box icon={faUserClock} title={'Latest'}>
                    {guild.captcha.latest.length ? (
                        guild.captcha.latest.slice(0, 7).map((e, k) => (
                            <Line key={`${e.at}-${k}`} css={tw`text-sm`}>
                                <span
                                    css={tw`w-2 h-2 rounded-full flex-none`}
                                    style={{ backgroundColor: EVENT[e.event]?.[1] }}
                                />
                                <span css={tw`min-w-0 truncate`} style={{ color: 'var(--color-base)' }}>
                                    <b>{e.name ?? e.user_id}</b> {EVENT[e.event]?.[0] ?? e.event}
                                </span>
                                <Muted css={tw`ml-auto text-xs whitespace-nowrap`}>{timeAgo(e.at)}</Muted>
                            </Line>
                        ))
                    ) : (
                        <Empty icon={faShieldAlt}>No one has joined since the captcha was set up.</Empty>
                    )}
                </Box>
            </Columns>
            <Box icon={faShieldAlt} title={'Captcha settings'}>
                <div css={tw`grid grid-cols-1 lg:grid-cols-2 gap-6`}>
                    <div>
                        <CaptchaSettings store={store} guild={guild} />
                    </div>
                    <div>
                        <p css={tw`mb-4 text-sm leading-relaxed`}>
                            <Muted>
                                Newcomers only see the verification channel until they pick the right pictures, drawn
                                like a reCAPTCHA. After the last miss they get a Discord timeout, then can try again.
                            </Muted>
                        </p>
                        <p css={tw`mb-4 text-sm leading-relaxed`}>
                            <Muted>
                                Not set up yet? <b>Quick setup</b> creates the role and the channel for you.
                            </Muted>
                        </p>
                        <Tools store={store} />
                    </div>
                </div>
            </Box>
        </>
    );
};

// ---------- Music ----------

const LOOPS: [string, string][] = [
    ['off', 'No loop'],
    ['track', 'Loop the track'],
    ['queue', 'Loop the queue'],
];

const FILTERS: [string, string][] = [
    ['none', 'No filter'],
    ['bassboost', 'Bass boost'],
    ['nightcore', 'Nightcore'],
    ['vaporwave', 'Vaporwave'],
    ['8d', '8D'],
    ['karaoke', 'Karaoke'],
];

const AddMusic = ({ store, guild, playing }: { store: DittoStore; guild: DittoGuild; playing: boolean }) => {
    const [query, setQuery] = useState('');
    const [channel, setChannel] = useState('');
    const [next, setNext] = useState(false);
    const ready = !!query.trim() && (playing || !!channel);
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!ready) return;
        store.music('play', { query, next, channelId: channel || undefined });
        setQuery('');
    };
    return (
        <form onSubmit={submit} css={tw`flex flex-wrap items-center gap-2`}>
            <div css={tw`flex-1`} style={{ minWidth: 220 }}>
                <Input
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                    placeholder={'A song, an artist or a link: Ditto picks the best match'}
                    maxLength={300}
                />
            </div>
            {!playing && (
                <div style={{ minWidth: 200 }}>
                    <Select value={channel} onChange={(e) => setChannel(e.currentTarget.value)}>
                        <option value={''}>In which voice channel?</option>
                        {guild.options.voiceChannels.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name}
                            </option>
                        ))}
                    </Select>
                </div>
            )}
            {playing && (
                <label
                    css={tw`flex items-center gap-2 px-2 text-sm cursor-pointer select-none`}
                    style={{ color: 'var(--color-base)' }}
                >
                    <Input type={'checkbox'} checked={next} onChange={(e) => setNext(e.currentTarget.checked)} />
                    Play next
                </label>
            )}
            <Button type={'submit'} disabled={!ready}>
                <FontAwesomeIcon icon={playing ? faPlus : faPlay} css={tw`mr-2`} />
                {playing ? 'Add' : 'Play'}
            </Button>
        </form>
    );
};

export const Music = ({ store, guild }: SectionProps) => {
    const m = guild.music;
    const [stop, setStop] = useState(false);
    const [clear, setClear] = useState(false);
    // The position moves every second between two refreshes.
    const [position, setPosition] = useState(m?.position ?? 0);
    useEffect(() => setPosition(m?.position ?? 0), [m?.position, m?.current?.title]);
    useEffect(() => {
        if (!m?.current || m.paused || m.current.live) return undefined;
        const timer = window.setInterval(
            () => setPosition((p) => (m.current?.duration ? Math.min(p + 1, m.current.duration) : p + 1)),
            1000
        );
        return () => window.clearInterval(timer);
    }, [m?.current?.title, m?.paused]);

    if (!m?.current) {
        return (
            <Box icon={faHeadphones} title={'Music'}>
                <Empty icon={faMusic}>
                    Nothing is playing. Pick a song and a voice channel: Ditto joins it and starts playing.
                </Empty>
                <AddMusic store={store} guild={guild} playing={false} />
            </Box>
        );
    }

    const t = m.current;
    const seekable = !!t.duration && !t.live;
    const square = Button.Shapes.IconSquare;
    return (
        <>
            <Dialog.Confirm
                open={stop}
                onClose={() => setStop(false)}
                title={'Stop the music?'}
                confirm={'Stop'}
                onConfirmed={() => {
                    setStop(false);
                    store.music('stop');
                }}
            >
                Ditto empties the queue and leaves the voice channel.
            </Dialog.Confirm>
            <Dialog.Confirm
                open={clear}
                onClose={() => setClear(false)}
                title={'Empty the queue?'}
                confirm={'Empty it'}
                onConfirmed={() => {
                    setClear(false);
                    store.music('clear');
                }}
            >
                The current track keeps playing; everything after it is removed.
            </Dialog.Confirm>
            <Card css={tw`mb-4`}>
                <CardBody css={tw`flex flex-wrap gap-6`}>
                    <Picture
                        src={t.thumbnail}
                        style={{ width: 180, height: 180, borderRadius: 'var(--border-radius, 8px)', flex: 'none' }}
                        fallback={
                            <div
                                css={tw`flex items-center justify-center flex-none text-5xl`}
                                style={{
                                    width: 180,
                                    height: 180,
                                    borderRadius: 'var(--border-radius, 8px)',
                                    backgroundColor: 'var(--color-background)',
                                    color: 'var(--color-muted)',
                                }}
                            >
                                <FontAwesomeIcon icon={faMusic} />
                            </div>
                        }
                    />
                    <div css={tw`flex flex-col flex-1 min-w-0`} style={{ minWidth: 260 }}>
                        <Muted css={tw`text-xs font-medium tracking-wide uppercase`}>
                            {m.paused ? 'Paused' : 'Now playing'}
                            {m.channel ? ` in ${m.channel}` : ''}
                        </Muted>
                        <a
                            href={t.link}
                            target={'_blank'}
                            rel={'noopener noreferrer'}
                            css={tw`block mt-1 text-2xl font-bold truncate font-header`}
                            style={{ color: 'var(--color-base)' }}
                        >
                            {t.title}
                        </a>
                        <Muted css={tw`block text-sm truncate`}>
                            {t.author}
                            {t.requester ? ` · asked by ${t.requester}` : ''}
                        </Muted>
                        {t.live ? (
                            <p css={tw`mt-4 text-sm font-bold text-red-400`}>● LIVE</p>
                        ) : (
                            <div css={tw`mt-4`}>
                                <div
                                    css={tw`relative h-2 rounded-full`}
                                    style={{
                                        backgroundColor: 'var(--color-background)',
                                        cursor: seekable ? 'pointer' : 'default',
                                    }}
                                    title={seekable ? 'Click to jump there' : ''}
                                    onClick={(e) => {
                                        if (!seekable) return;
                                        const r = e.currentTarget.getBoundingClientRect();
                                        store.music('seek', {
                                            value: Math.floor(((e.clientX - r.left) / r.width) * (t.duration ?? 0)),
                                        });
                                    }}
                                >
                                    <div
                                        css={tw`absolute inset-y-0 left-0 rounded-full`}
                                        style={{
                                            width: `${t.duration ? Math.min(100, (position / t.duration) * 100) : 0}%`,
                                            backgroundColor: 'var(--color-primary)',
                                            transition: 'width 1s linear',
                                        }}
                                    />
                                </div>
                                <div
                                    css={tw`flex justify-between mt-1 text-xs`}
                                    style={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                    <Muted>{formatTime(position)}</Muted>
                                    <Muted>{formatTime(t.duration)}</Muted>
                                </div>
                            </div>
                        )}
                        <div css={tw`flex flex-wrap items-center gap-2 mt-auto pt-4`}>
                            <Button.Text shape={square} title={'Previous'} onClick={() => store.music('previous')}>
                                <FontAwesomeIcon icon={faStepBackward} />
                            </Button.Text>
                            <Button
                                shape={square}
                                title={m.paused ? 'Resume' : 'Pause'}
                                onClick={() => store.music(m.paused ? 'resume' : 'pause')}
                            >
                                <FontAwesomeIcon icon={m.paused ? faPlay : faPause} />
                            </Button>
                            <Button.Text shape={square} title={'Skip'} onClick={() => store.music('skip')}>
                                <FontAwesomeIcon icon={faStepForward} />
                            </Button.Text>
                            <Button.Danger shape={square} title={'Stop and leave'} onClick={() => setStop(true)}>
                                <FontAwesomeIcon icon={faStop} />
                            </Button.Danger>
                            <div css={tw`flex items-center gap-2 ml-auto`} style={{ minWidth: 180 }}>
                                <FontAwesomeIcon icon={faVolumeUp} style={{ color: 'var(--color-muted)' }} />
                                <input
                                    type={'range'}
                                    min={0}
                                    max={100}
                                    defaultValue={m.volume}
                                    key={m.volume}
                                    aria-label={'Volume'}
                                    css={tw`flex-1`}
                                    style={{ accentColor: 'var(--color-primary)' }}
                                    onMouseUp={(e) => store.music('volume', { value: Number(e.currentTarget.value) })}
                                    onTouchEnd={(e) => store.music('volume', { value: Number(e.currentTarget.value) })}
                                    onKeyUp={(e) => store.music('volume', { value: Number(e.currentTarget.value) })}
                                />
                                <Muted css={tw`w-10 text-xs text-right`}>{m.volume}%</Muted>
                            </div>
                        </div>
                    </div>
                </CardBody>
                <div
                    css={tw`grid grid-cols-1 sm:grid-cols-2 gap-3 px-4 py-3`}
                    style={{ borderTop: '1px solid var(--color-neutral)', backgroundColor: 'var(--color-background)' }}
                >
                    <Select value={m.loop} onChange={(e) => store.music('loop', { value: e.currentTarget.value })}>
                        {LOOPS.map(([v, l]) => (
                            <option key={v} value={v}>
                                {l}
                            </option>
                        ))}
                    </Select>
                    <Select value={m.filter} onChange={(e) => store.music('filter', { value: e.currentTarget.value })}>
                        {FILTERS.map(([v, l]) => (
                            <option key={v} value={v}>
                                {l}
                            </option>
                        ))}
                    </Select>
                </div>
            </Card>
            <Box icon={faPlus} title={'Add music'} css={tw`mb-4`}>
                <AddMusic store={store} guild={guild} playing />
            </Box>
            <Box
                icon={faListOl}
                title={`Up next · ${m.queueLength}`}
                actions={
                    <>
                        <Button.Text size={Small} disabled={m.queueLength < 2} onClick={() => store.music('shuffle')}>
                            <FontAwesomeIcon icon={faRandom} css={tw`mr-2`} />
                            Shuffle
                        </Button.Text>
                        <Button.Danger size={Small} disabled={!m.queueLength} onClick={() => setClear(true)}>
                            <FontAwesomeIcon icon={faTrash} css={tw`mr-2`} />
                            Clear
                        </Button.Danger>
                    </>
                }
            >
                {m.queue.length ? (
                    m.queue.map((q, k) => (
                        <Line key={`${k}-${q.title}`}>
                            <Muted css={tw`w-6 text-xs text-right flex-none`}>{k + 1}</Muted>
                            <Picture
                                src={q.thumbnail}
                                style={{ width: 40, height: 40, borderRadius: 6, flex: 'none' }}
                                fallback={
                                    <span
                                        css={tw`flex items-center justify-center flex-none w-10 h-10 text-sm`}
                                        style={{
                                            borderRadius: 6,
                                            backgroundColor: 'var(--color-background)',
                                            color: 'var(--color-muted)',
                                        }}
                                    >
                                        <FontAwesomeIcon icon={faMusic} />
                                    </span>
                                }
                            />
                            <div css={tw`flex-1 min-w-0`}>
                                <div css={tw`text-sm font-medium truncate`} style={{ color: 'var(--color-base)' }}>
                                    {q.title}
                                </div>
                                <Muted css={tw`block text-xs truncate`}>
                                    {q.author}
                                    {q.requester ? ` · asked by ${q.requester}` : ''}
                                </Muted>
                            </div>
                            <Muted css={tw`text-xs`}>{formatTime(q.duration)}</Muted>
                            <Button.Text
                                size={Small}
                                shape={square}
                                title={'Remove from the queue'}
                                onClick={() => store.music('remove', { value: k })}
                            >
                                <FontAwesomeIcon icon={faTimes} />
                            </Button.Text>
                        </Line>
                    ))
                ) : (
                    <Empty icon={faListOl}>Nothing after this track. Add songs above.</Empty>
                )}
            </Box>
        </>
    );
};

// ---------- Voice ----------

const VoiceSettings = ({ store, guild }: { store: DittoStore; guild: DittoGuild }) => {
    const c = guild.config;
    const o = guild.options;
    const features = (key: 'voiceLog' | 'autoAfk', on: boolean) => {
        const next = { voiceLog: c.voiceLog, autoAfk: c.autoAfk, [key]: on };
        store.save(
            'features',
            (Object.keys(next) as ('voiceLog' | 'autoAfk')[]).filter((k) => next[k])
        );
    };
    return (
        <>
            <Field label={'Rooms'} hint={'The first person in owns the room; it goes back to normal once empty.'}>
                <MultiSelect options={o.voiceChannels} values={c.rooms} onChange={(v) => store.save('rooms', v)} />
            </Field>
            <Toggle
                name={'ditto-voice-log'}
                label={'Voice log'}
                description={'Joins, leaves and moves go to the log channel.'}
                checked={c.voiceLog}
                onChange={(on) => features('voiceLog', on)}
            />
            <Toggle
                name={'ditto-auto-afk'}
                label={'Move deafened members to AFK'}
                description={'Uses the server’s AFK channel.'}
                checked={c.autoAfk}
                onChange={(on) => features('autoAfk', on)}
            />
            {c.autoAfk && (
                <Field label={'AFK after'}>
                    <NumberSelect
                        choices={[5, 10, 15, 30, 60]}
                        value={c.afkIdleMinutes}
                        format={(n) => `${n} minutes deafened`}
                        onChange={(v) => store.save('afkIdleMinutes', v)}
                    />
                </Field>
            )}
        </>
    );
};

export const Voice = ({ store, guild }: SectionProps) => (
    <Columns>
        <Box icon={faLock} title={`Locked channels · ${guild.locks.length}`}>
            {guild.locks.length ? (
                guild.locks.map((l) => (
                    <Line key={l.channelId}>
                        <span
                            css={tw`flex items-center justify-center flex-none w-8 h-8 text-sm rounded-full`}
                            style={{ backgroundColor: 'var(--color-neutral)', color: 'var(--color-base)' }}
                        >
                            <FontAwesomeIcon icon={faLock} />
                        </span>
                        <div css={tw`flex-1 min-w-0`}>
                            <div css={tw`text-sm font-medium truncate`} style={{ color: 'var(--color-base)' }}>
                                {l.channel}
                            </div>
                            <Muted css={tw`block text-xs`}>
                                {l.members} member(s) allowed ·{' '}
                                {l.expiresAt
                                    ? `until ${new Date(l.expiresAt).toLocaleTimeString([], {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                      })}`
                                    : 'until unlocked'}
                            </Muted>
                        </div>
                        <Button.Text size={Small} onClick={() => store.unlock(l.channelId)}>
                            <FontAwesomeIcon icon={faUnlock} css={tw`mr-2`} />
                            Unlock
                        </Button.Text>
                    </Line>
                ))
            ) : (
                <Empty icon={faUnlock}>
                    No channel is locked. In Discord, <b>/lock</b> keeps a voice channel to the people in it.
                </Empty>
            )}
        </Box>
        <Box icon={faVolumeUp} title={'Voice settings'}>
            <VoiceSettings store={store} guild={guild} />
        </Box>
    </Columns>
);

// ---------- Settings ----------

export const Settings = ({ store, guild }: SectionProps) => {
    const c = guild.config;
    const o = guild.options;
    return (
        <>
            <Columns>
                <Box icon={faShieldAlt} title={'Verification'}>
                    <CaptchaSettings store={store} guild={guild} />
                </Box>
                <div css={tw`grid gap-4`}>
                    <Box icon={faUserShield} title={'Staff'}>
                        <Field label={'Staff roles'} hint={'Can use every Ditto command, and /dashboard.'}>
                            <MultiSelect
                                options={o.roles}
                                values={c.staffRoles}
                                onChange={(v) => store.save('staffRoles', v)}
                            />
                        </Field>
                        <Field label={'Log channel'} hint={'Where Ditto writes joins, captcha results and moderation.'}>
                            <SingleSelect
                                options={o.textChannels}
                                value={c.logChannel}
                                onChange={(v) => store.save('logChannel', v)}
                            />
                        </Field>
                    </Box>
                    <Box icon={faUserClock} title={'Quarantine'}>
                        <Field
                            label={'Quarantine role'}
                            hint={'Given instead of the captcha to members brought in by the bots below.'}
                        >
                            <SingleSelect
                                options={o.roles}
                                value={c.quarantineRole}
                                onChange={(v) => store.save('quarantineRole', v)}
                            />
                        </Field>
                        <Field label={'Watched bots'}>
                            <MultiSelect
                                options={o.bots}
                                values={c.quarantineBots}
                                onChange={(v) => store.save('quarantineBots', v)}
                            />
                        </Field>
                    </Box>
                </div>
            </Columns>
            <Columns>
                <Box icon={faVolumeUp} title={'Voice'}>
                    <VoiceSettings store={store} guild={guild} />
                </Box>
                <Box icon={faBolt} title={'Tools'}>
                    <p css={tw`mb-4 text-sm leading-relaxed`}>
                        <Muted>
                            <b>Quick setup</b> creates what the captcha needs. <b>Auto-detect</b> fills empty settings
                            from your role and channel names and never overwrites a choice. <b>Post the panel</b> sends
                            the Verify panel again.
                        </Muted>
                    </p>
                    <Tools store={store} />
                </Box>
            </Columns>
        </>
    );
};

// ---------- Logs ----------

export const Logs = ({ guild }: SectionProps) => {
    const [filter, setFilter] = useState('');
    const words = filter.trim().toLowerCase();
    const lines = [...guild.logs].reverse().filter((l) => !words || l.text.toLowerCase().includes(words));
    return (
        <Box
            icon={faStream}
            title={'Activity'}
            actions={
                <div style={{ width: 220 }}>
                    <Input value={filter} onChange={(e) => setFilter(e.currentTarget.value)} placeholder={'Filter…'} />
                </div>
            }
        >
            {lines.length ? (
                <LogLines guild={guild} lines={lines.slice(0, 300)} />
            ) : (
                <Empty icon={faStream}>
                    {words ? 'Nothing matches.' : 'Nothing has happened since Ditto started.'}
                </Empty>
            )}
            <p css={tw`mt-4 text-xs`}>
                <Muted>Updated live. The full history is in your Discord log channel.</Muted>
            </p>
        </Box>
    );
};

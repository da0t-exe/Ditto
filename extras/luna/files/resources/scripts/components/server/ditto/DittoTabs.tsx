import React, { useEffect, useState } from 'react';
import tw from 'twin.macro';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    faBolt,
    faCheck,
    faLock,
    faMusic,
    faPause,
    faPlay,
    faRandom,
    faSearch,
    faStepBackward,
    faStepForward,
    faStop,
    faThumbtack,
    faTimes,
    faTrash,
    faUnlock,
} from '@fortawesome/free-solid-svg-icons';
import Button from '@/components/elements/Button';
import Input from '@/components/elements/Input';
import Select from '@/components/elements/Select';
import { DittoCaptchaEvent, DittoGuild } from '@/api/server/ditto';
import type { DittoActions } from './DittoContainer';
import {
    Card,
    CardTitle,
    DiscordText,
    Field,
    Grid,
    Kpi,
    ListItem,
    Muted,
    MultiSelect,
    NumberSelect,
    Picture,
    Row,
    SingleSelect,
    Toggle,
    formatTime,
} from './ui';

interface Props {
    guild: DittoGuild;
    actions: DittoActions;
}

const QUICK_CONFIRM =
    'Quick setup creates what is missing (an Unverified role, #verify and #ditto-logs), hides every other channel from Unverified, and posts the Verify panel.\n\nExisting members keep their access. Delete the Unverified role to undo it. Continue?';

const Tools = ({ actions }: { actions: DittoActions }) => (
    <Row>
        <Button onClick={() => window.confirm(QUICK_CONFIRM) && actions.run('quick-setup')}>
            <FontAwesomeIcon icon={faBolt} css={tw`mr-2`} />
            Quick setup
        </Button>
        <Button color={'grey'} onClick={() => actions.run('detect')}>
            <FontAwesomeIcon icon={faSearch} css={tw`mr-2`} />
            Auto-detect
        </Button>
        <Button color={'grey'} onClick={() => actions.run('panel')}>
            <FontAwesomeIcon icon={faThumbtack} css={tw`mr-2`} />
            Post the panel
        </Button>
    </Row>
);

const Logs = ({ guild, limit }: { guild: DittoGuild; limit: number }) => {
    const lines = [...guild.logs].reverse().slice(0, limit);
    if (!lines.length) return <Muted css={tw`text-sm`}>Nothing logged since Ditto started.</Muted>;
    return (
        <div css={tw`grid gap-1 text-sm overflow-y-auto`} style={{ maxHeight: 560 }}>
            {lines.map((l, k) => (
                <ListItem key={`${l.at}-${k}`} css={tw`items-start`}>
                    <Muted css={tw`flex-none`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {new Date(l.at).toLocaleTimeString()}
                    </Muted>
                    <span style={{ color: 'var(--color-base)' }}>
                        <DiscordText text={l.text} guild={guild} />
                    </span>
                </ListItem>
            ))}
        </div>
    );
};

// ---------- Overview ----------

export const OverviewTab = ({ guild, actions }: Props) => {
    const c = guild.config;
    const t = guild.captcha.totals;
    const m = guild.music;
    const checks: [boolean, string, string][] = [
        [
            guild.verification,
            'Captcha',
            guild.verification
                ? 'Newcomers verify before they see the server'
                : 'Not set up — Quick setup does it in one click',
        ],
        [
            c.staffRoles.length > 0,
            'Staff roles',
            c.staffRoles.length ? `${c.staffRoles.length} role(s)` : 'Only admins and the owner',
        ],
        [!!c.logChannel, 'Log channel', c.logChannel ? 'Joins, captcha and moderation are logged' : 'No log channel'],
        [c.rooms.length > 0, 'Rooms', c.rooms.length ? `${c.rooms.length} room(s) reset when empty` : 'Optional'],
        [!!c.quarantineRole, 'Quarantine', c.quarantineRole ? `${c.quarantineBots.length} bot(s) watched` : 'Optional'],
    ];
    return (
        <div css={tw`grid gap-4`}>
            <Grid $min={180}>
                <Kpi label={'Members'} value={guild.members.toLocaleString()} sub={'on the Discord server'} />
                <Kpi label={'Verified'} value={t.pass} sub={'last 14 days'} />
                <Kpi label={'Missed'} value={t.fail} sub={`${t.lockout} timed out`} />
                <Kpi
                    label={'Music'}
                    value={m?.current ? (m.paused ? 'Paused' : 'Playing') : 'Idle'}
                    sub={m?.current ? `${m.current.title} — ${m.current.author}` : 'nothing playing'}
                />
            </Grid>
            <Grid>
                <Card>
                    <CardTitle>Setup</CardTitle>
                    <div css={tw`grid gap-2 mb-4`}>
                        {checks.map(([ok, name, sub]) => (
                            <ListItem key={name}>
                                <span
                                    css={tw`flex items-center justify-center w-6 h-6 rounded-full text-xs flex-none`}
                                    style={{
                                        backgroundColor: ok ? '#22c55e' : 'var(--color-background-secondary)',
                                        border: '1px solid var(--color-neutral)',
                                        color: '#fff',
                                    }}
                                >
                                    {ok && <FontAwesomeIcon icon={faCheck} />}
                                </span>
                                <div>
                                    <div css={tw`text-sm font-medium`} style={{ color: 'var(--color-base)' }}>
                                        {name}
                                    </div>
                                    <Muted css={tw`text-xs`}>{sub}</Muted>
                                </div>
                            </ListItem>
                        ))}
                    </div>
                    <Tools actions={actions} />
                </Card>
                <Card>
                    <CardTitle>Recent activity</CardTitle>
                    <Logs guild={guild} limit={8} />
                </Card>
            </Grid>
        </div>
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
            <div css={tw`flex items-end gap-1`} style={{ height: 140 }}>
                {days.map((d) => (
                    <div
                        key={d}
                        title={`${d}: ${SERIES.map(([e, , l]) => `${l} ${by[`${d}:${e}`] || 0}`).join(', ')}`}
                        css={tw`flex flex-col-reverse flex-1 h-full gap-px rounded`}
                        style={{ backgroundColor: 'var(--color-background)' }}
                    >
                        {SERIES.map(([e, color]) => {
                            const n = by[`${d}:${e}`] || 0;
                            return n ? (
                                <div
                                    key={e}
                                    css={tw`rounded`}
                                    style={{
                                        height: `${(n / max) * 100}%`,
                                        backgroundColor: color,
                                    }}
                                />
                            ) : null;
                        })}
                    </div>
                ))}
            </div>
            <Row css={tw`mt-3 text-xs gap-4`}>
                {SERIES.map(([e, color, l]) => (
                    <Muted key={e}>
                        <span css={tw`inline-block w-2 h-2 mr-1 rounded-sm`} style={{ backgroundColor: color }} />
                        {l}
                    </Muted>
                ))}
            </Row>
        </div>
    );
};

const EVENT_LABEL: Record<DittoCaptchaEvent, string> = {
    join: 'joined',
    pass: 'passed',
    fail: 'missed',
    lockout: 'timed out',
    quarantine: 'quarantined',
};

const CaptchaSettings = ({ guild, actions }: Props) => {
    const c = guild.config;
    const o = guild.options;
    return (
        <>
            <Field label={'Pending role'} hint={'Held by newcomers until they pass; hide your channels from it.'}>
                <SingleSelect
                    options={o.roles}
                    value={c.pendingRole}
                    onChange={(v) => actions.save('pendingRole', v)}
                />
            </Field>
            <Field
                label={'Member role (optional)'}
                hint={'Given after the captcha, if your channels are opened to a role.'}
            >
                <SingleSelect options={o.roles} value={c.memberRole} onChange={(v) => actions.save('memberRole', v)} />
            </Field>
            <Field label={'Verification channel'}>
                <SingleSelect
                    options={o.textChannels}
                    value={c.verifyChannel}
                    onChange={(v) => actions.save('verifyChannel', v)}
                />
            </Field>
            <Field label={'Attempts'}>
                <NumberSelect
                    choices={[3, 4, 5, 6]}
                    value={c.captchaAttempts}
                    format={(n) => `${n} attempts`}
                    onChange={(v) => actions.save('captchaAttempts', v)}
                />
            </Field>
            <Field label={'Pause after the last miss'}>
                <NumberSelect
                    choices={[5, 10, 30, 60]}
                    value={c.captchaTimeoutMinutes}
                    format={(n) => `${n} minutes`}
                    onChange={(v) => actions.save('captchaTimeoutMinutes', v)}
                />
            </Field>
        </>
    );
};

export const CaptchaTab = ({ guild, actions }: Props) => {
    const t = guild.captcha.totals;
    return (
        <div css={tw`grid gap-4`}>
            <Grid $min={180}>
                <Kpi label={'Joined'} value={t.join} sub={'14 days'} />
                <Kpi label={'Passed'} value={t.pass} sub={'14 days'} />
                <Kpi label={'Missed'} value={t.fail} sub={'14 days'} />
                <Kpi label={'Quarantined'} value={t.quarantine} sub={'14 days'} />
            </Grid>
            <Grid>
                <Card>
                    <CardTitle>Last 14 days</CardTitle>
                    <Chart guild={guild} />
                </Card>
                <Card>
                    <CardTitle>Latest</CardTitle>
                    {guild.captcha.latest.length ? (
                        <div css={tw`grid gap-1 text-sm`}>
                            {guild.captcha.latest.slice(0, 8).map((e, k) => (
                                <ListItem key={`${e.at}-${k}`}>
                                    <span css={tw`mr-auto truncate`} style={{ color: 'var(--color-base)' }}>
                                        <b>{e.name ?? e.user_id}</b> {EVENT_LABEL[e.event] ?? e.event}
                                    </span>
                                    <Muted css={tw`text-xs`}>{new Date(e.at).toLocaleString()}</Muted>
                                </ListItem>
                            ))}
                        </div>
                    ) : (
                        <Muted css={tw`text-sm`}>Nothing yet.</Muted>
                    )}
                </Card>
            </Grid>
            <Card>
                <CardTitle>Captcha settings</CardTitle>
                <Grid>
                    <div>
                        <CaptchaSettings guild={guild} actions={actions} />
                    </div>
                    <div>
                        <p css={tw`mb-4 text-sm`}>
                            <Muted>
                                Newcomers see only the verification channel. The challenge is drawn like a reCAPTCHA;
                                after the last miss they get a Discord timeout.
                            </Muted>
                        </p>
                        <Tools actions={actions} />
                    </div>
                </Grid>
            </Card>
        </div>
    );
};

// ---------- Music ----------

const LOOPS: [string, string][] = [
    ['off', 'Loop off'],
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

const AddMusic = ({ guild, actions, playing }: Props & { playing: boolean }) => {
    const [query, setQuery] = useState('');
    const [channel, setChannel] = useState('');
    const [next, setNext] = useState(false);
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim() || (!playing && !channel)) return;
        actions.music('play', { query, next, channelId: channel || undefined });
        setQuery('');
    };
    return (
        <form onSubmit={submit}>
            <Row>
                <div css={tw`flex-1`} style={{ minWidth: 220 }}>
                    <Input
                        value={query}
                        onChange={(e) => setQuery(e.currentTarget.value)}
                        placeholder={'Song name or link — Ditto picks the best match'}
                        maxLength={300}
                    />
                </div>
                {!playing && (
                    <div style={{ minWidth: 200 }}>
                        <Select value={channel} onChange={(e) => setChannel(e.currentTarget.value)}>
                            <option value={''}>Voice channel…</option>
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
                        css={tw`flex items-center gap-2 text-sm cursor-pointer`}
                        style={{ color: 'var(--color-base)' }}
                    >
                        <input type={'checkbox'} checked={next} onChange={(e) => setNext(e.currentTarget.checked)} />
                        Play next
                    </label>
                )}
                <Button type={'submit'} disabled={!query.trim() || (!playing && !channel)}>
                    {playing ? 'Add' : 'Play'}
                </Button>
            </Row>
        </form>
    );
};

export const MusicTab = ({ guild, actions }: Props) => {
    const m = guild.music;
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
            <Card>
                <CardTitle>Nothing is playing</CardTitle>
                <p css={tw`mb-4 text-sm`}>
                    <Muted>Start the music from here: Ditto joins the voice channel you pick.</Muted>
                </p>
                <AddMusic guild={guild} actions={actions} playing={false} />
            </Card>
        );
    }

    const t = m.current;
    const seekable = !!t.duration && !t.live;
    const round = { width: 40, height: 40, padding: 0 };
    return (
        <div css={tw`grid gap-4`}>
            <Card>
                <div css={tw`flex flex-wrap gap-5`}>
                    <Picture
                        src={t.thumbnail}
                        style={{
                            width: 170,
                            height: 170,
                            borderRadius: 'var(--border-radius, 12px)',
                        }}
                        fallback={
                            <div
                                css={tw`flex items-center justify-center text-4xl`}
                                style={{
                                    width: 170,
                                    height: 170,
                                    borderRadius: 'var(--border-radius, 12px)',
                                    backgroundColor: 'var(--color-background)',
                                    color: 'var(--color-muted)',
                                }}
                            >
                                <FontAwesomeIcon icon={faMusic} />
                            </div>
                        }
                    />
                    <div css={tw`flex-1`} style={{ minWidth: 240 }}>
                        <Muted css={tw`text-xs uppercase tracking-wide`}>
                            {m.paused ? 'Paused' : 'Now playing'}
                            {m.channel ? ` · ${m.channel}` : ''}
                        </Muted>
                        <a
                            href={t.link}
                            target={'_blank'}
                            rel={'noopener noreferrer'}
                            css={tw`block mt-1 text-xl font-bold truncate`}
                            style={{ color: 'var(--color-base)' }}
                        >
                            {t.title}
                        </a>
                        <Muted css={tw`block text-sm truncate`}>
                            {t.author}
                            {t.requester ? ` · requested by ${t.requester}` : ''}
                        </Muted>
                        {t.live ? (
                            <p css={tw`mt-4 text-sm font-bold text-red-400`}>● LIVE</p>
                        ) : (
                            <div css={tw`mt-4`}>
                                <div
                                    css={tw`relative h-2 rounded-full cursor-pointer`}
                                    style={{ backgroundColor: 'var(--color-background)' }}
                                    title={seekable ? 'Click to jump' : ''}
                                    onClick={(e) => {
                                        if (!seekable) return;
                                        const r = e.currentTarget.getBoundingClientRect();
                                        actions.music('seek', {
                                            value: Math.floor(((e.clientX - r.left) / r.width) * (t.duration ?? 0)),
                                        });
                                    }}
                                >
                                    <div
                                        css={tw`absolute inset-y-0 left-0 rounded-full`}
                                        style={{
                                            width: `${t.duration ? Math.min(100, (position / t.duration) * 100) : 0}%`,
                                            backgroundColor: 'var(--color-primary)',
                                        }}
                                    />
                                </div>
                                <Row css={tw`justify-between mt-1 text-xs`}>
                                    <Muted>{formatTime(position)}</Muted>
                                    <Muted>{formatTime(t.duration)}</Muted>
                                </Row>
                            </div>
                        )}
                        <Row css={tw`mt-4`}>
                            <Button
                                color={'grey'}
                                style={round}
                                title={'Previous'}
                                onClick={() => actions.music('previous')}
                            >
                                <FontAwesomeIcon icon={faStepBackward} />
                            </Button>
                            <Button
                                style={{ ...round, width: 48, height: 48 }}
                                title={m.paused ? 'Resume' : 'Pause'}
                                onClick={() => actions.music(m.paused ? 'resume' : 'pause')}
                            >
                                <FontAwesomeIcon icon={m.paused ? faPlay : faPause} />
                            </Button>
                            <Button color={'grey'} style={round} title={'Skip'} onClick={() => actions.music('skip')}>
                                <FontAwesomeIcon icon={faStepForward} />
                            </Button>
                            <Button
                                color={'red'}
                                style={round}
                                title={'Stop and leave'}
                                onClick={() =>
                                    window.confirm('Stop the music and leave the voice channel?') &&
                                    actions.music('stop')
                                }
                            >
                                <FontAwesomeIcon icon={faStop} />
                            </Button>
                            <div css={tw`w-40`}>
                                <Select
                                    value={m.loop}
                                    onChange={(e) => actions.music('loop', { value: e.currentTarget.value })}
                                >
                                    {LOOPS.map(([v, l]) => (
                                        <option key={v} value={v}>
                                            {l}
                                        </option>
                                    ))}
                                </Select>
                            </div>
                            <div css={tw`w-40`}>
                                <Select
                                    value={m.filter}
                                    onChange={(e) => actions.music('filter', { value: e.currentTarget.value })}
                                >
                                    {FILTERS.map(([v, l]) => (
                                        <option key={v} value={v}>
                                            {l}
                                        </option>
                                    ))}
                                </Select>
                            </div>
                        </Row>
                        <Row css={tw`mt-3`} style={{ maxWidth: 360 }}>
                            <Muted css={tw`text-xs`}>Volume</Muted>
                            <input
                                type={'range'}
                                min={0}
                                max={100}
                                defaultValue={m.volume}
                                key={m.volume}
                                css={tw`flex-1`}
                                style={{ accentColor: 'var(--color-primary)' }}
                                onMouseUp={(e) =>
                                    actions.music('volume', {
                                        value: Number(e.currentTarget.value),
                                    })
                                }
                                onKeyUp={(e) =>
                                    actions.music('volume', {
                                        value: Number(e.currentTarget.value),
                                    })
                                }
                            />
                            <Muted css={tw`text-xs w-10`}>{m.volume}%</Muted>
                        </Row>
                    </div>
                </div>
            </Card>
            <Card>
                <CardTitle>Add music</CardTitle>
                <AddMusic guild={guild} actions={actions} playing />
            </Card>
            <Card>
                <Row css={tw`mb-3`}>
                    <CardTitle css={tw`mb-0 mr-auto`}>Queue · {m.queueLength}</CardTitle>
                    <Button
                        color={'grey'}
                        size={'xsmall'}
                        disabled={m.queueLength < 2}
                        onClick={() => actions.music('shuffle')}
                    >
                        <FontAwesomeIcon icon={faRandom} css={tw`mr-2`} />
                        Shuffle
                    </Button>
                    <Button
                        color={'red'}
                        size={'xsmall'}
                        disabled={!m.queueLength}
                        onClick={() => window.confirm('Empty the queue?') && actions.music('clear')}
                    >
                        <FontAwesomeIcon icon={faTrash} css={tw`mr-2`} />
                        Clear
                    </Button>
                </Row>
                {m.queue.length ? (
                    <div css={tw`grid gap-1`}>
                        {m.queue.map((q, k) => (
                            <ListItem key={`${k}-${q.title}`}>
                                <Muted css={tw`w-6 text-right text-xs`}>{k + 1}</Muted>
                                <Picture
                                    src={q.thumbnail}
                                    style={{
                                        width: 40,
                                        height: 40,
                                        borderRadius: 6,
                                        flex: 'none',
                                    }}
                                />
                                <div css={tw`flex-1 min-w-0`}>
                                    <div css={tw`text-sm font-medium truncate`} style={{ color: 'var(--color-base)' }}>
                                        {q.title}
                                    </div>
                                    <Muted css={tw`block text-xs truncate`}>{q.author}</Muted>
                                </div>
                                <Muted css={tw`text-xs`}>{formatTime(q.duration)}</Muted>
                                <Button
                                    color={'grey'}
                                    size={'xsmall'}
                                    title={'Remove'}
                                    onClick={() => actions.music('remove', { value: k })}
                                >
                                    <FontAwesomeIcon icon={faTimes} />
                                </Button>
                            </ListItem>
                        ))}
                    </div>
                ) : (
                    <Muted css={tw`text-sm`}>Nothing queued after this track.</Muted>
                )}
            </Card>
        </div>
    );
};

// ---------- Voice ----------

const VoiceSettings = ({ guild, actions }: Props) => {
    const c = guild.config;
    const o = guild.options;
    const features = (key: 'voiceLog' | 'autoAfk', on: boolean) => {
        const next = { voiceLog: c.voiceLog, autoAfk: c.autoAfk, [key]: on };
        actions.save(
            'features',
            (Object.keys(next) as ('voiceLog' | 'autoAfk')[]).filter((k) => next[k])
        );
    };
    return (
        <>
            <Field label={'Rooms'} hint={'The first person in owns the room; it goes back to normal when it empties.'}>
                <MultiSelect options={o.voiceChannels} values={c.rooms} onChange={(v) => actions.save('rooms', v)} />
            </Field>
            <Field label={'Log channel'}>
                <SingleSelect
                    options={o.textChannels}
                    value={c.logChannel}
                    onChange={(v) => actions.save('logChannel', v)}
                />
            </Field>
            <Toggle
                label={'Voice log: joins, leaves and moves'}
                checked={c.voiceLog}
                onChange={(on) => features('voiceLog', on)}
            />
            <Toggle
                label={'Move deafened members to AFK'}
                checked={c.autoAfk}
                onChange={(on) => features('autoAfk', on)}
            />
            <Field label={'AFK after'}>
                <NumberSelect
                    choices={[5, 10, 15, 30, 60]}
                    value={c.afkIdleMinutes}
                    format={(n) => `${n} minutes deafened`}
                    onChange={(v) => actions.save('afkIdleMinutes', v)}
                />
            </Field>
        </>
    );
};

export const VoiceTab = ({ guild, actions }: Props) => (
    <Grid>
        <Card>
            <CardTitle>
                <FontAwesomeIcon icon={faLock} /> Locked channels · {guild.locks.length}
            </CardTitle>
            {guild.locks.length ? (
                <div css={tw`grid gap-2`}>
                    {guild.locks.map((l) => (
                        <ListItem key={l.channelId}>
                            <div css={tw`flex-1`}>
                                <div css={tw`text-sm font-medium`} style={{ color: 'var(--color-base)' }}>
                                    {l.channel}
                                </div>
                                <Muted css={tw`text-xs`}>
                                    {l.members} tracked ·{' '}
                                    {l.expiresAt ? `until ${new Date(l.expiresAt).toLocaleTimeString()}` : 'no limit'}
                                </Muted>
                            </div>
                            <Button color={'grey'} size={'xsmall'} onClick={() => actions.unlock(l.channelId)}>
                                <FontAwesomeIcon icon={faUnlock} css={tw`mr-2`} />
                                Unlock
                            </Button>
                        </ListItem>
                    ))}
                </div>
            ) : (
                <Muted css={tw`text-sm`}>No locked channel. Use /lock in Discord.</Muted>
            )}
        </Card>
        <Card>
            <CardTitle>Voice settings</CardTitle>
            <VoiceSettings guild={guild} actions={actions} />
        </Card>
    </Grid>
);

// ---------- Settings ----------

export const SettingsTab = ({ guild, actions }: Props) => {
    const c = guild.config;
    const o = guild.options;
    return (
        <Grid>
            <Card>
                <CardTitle>Verification</CardTitle>
                <CaptchaSettings guild={guild} actions={actions} />
            </Card>
            <Card>
                <CardTitle>Staff & quarantine</CardTitle>
                <Field label={'Staff roles'} hint={'Can use every Ditto command and the dashboard.'}>
                    <MultiSelect
                        options={o.roles}
                        values={c.staffRoles}
                        onChange={(v) => actions.save('staffRoles', v)}
                    />
                </Field>
                <Field
                    label={'Quarantine role'}
                    hint={'Given instead of the captcha to members brought in by the bots below.'}
                >
                    <SingleSelect
                        options={o.roles}
                        value={c.quarantineRole}
                        onChange={(v) => actions.save('quarantineRole', v)}
                    />
                </Field>
                <Field label={'Watched bots'}>
                    <MultiSelect
                        options={o.bots}
                        values={c.quarantineBots}
                        onChange={(v) => actions.save('quarantineBots', v)}
                    />
                </Field>
            </Card>
            <Card>
                <CardTitle>Voice & logs</CardTitle>
                <VoiceSettings guild={guild} actions={actions} />
            </Card>
            <Card>
                <CardTitle>Tools</CardTitle>
                <p css={tw`mb-4 text-sm`}>
                    <Muted>
                        Auto-detect fills empty settings from your role and channel names. It never overwrites a choice.
                    </Muted>
                </p>
                <Tools actions={actions} />
            </Card>
        </Grid>
    );
};

// ---------- Logs ----------

export const LogsTab = ({ guild }: { guild: DittoGuild }) => (
    <Card>
        <CardTitle>
            Activity <Muted css={tw`ml-auto text-xs normal-case tracking-normal`}>live · since Ditto started</Muted>
        </CardTitle>
        <Logs guild={guild} limit={200} />
    </Card>
);

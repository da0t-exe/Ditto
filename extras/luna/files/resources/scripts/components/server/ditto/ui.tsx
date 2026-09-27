import React from 'react';
import styled, { css } from 'styled-components/macro';
import tw from 'twin.macro';
import Select from '@/components/elements/Select';
import { DittoGuild, DittoOption } from '@/api/server/ditto';

/* Ditto addon: small building blocks drawn with Luna's own colour variables, so the
   tab follows the panel's theme, dark or light. */

export const Card = styled.div`
    ${tw`p-4`};
    background-color: var(--color-background-secondary);
    border: 1px solid var(--color-neutral);
    border-radius: var(--border-radius, 12px);
`;

export const CardTitle = styled.h3`
    ${tw`flex items-center gap-2 mb-3 text-sm font-medium uppercase tracking-wide`};
    color: var(--color-base);
`;

export const Muted = styled.span`
    color: var(--color-muted);
`;

export const Grid = styled.div<{ $min?: number }>`
    ${tw`grid gap-4`};
    grid-template-columns: repeat(auto-fit, minmax(${(p) => p.$min ?? 320}px, 1fr));
`;

export const Row = styled.div`
    ${tw`flex flex-wrap items-center gap-2`};
`;

export const Pill = styled.span<{ $tone?: 'good' | 'bad' | 'neutral' }>`
    ${tw`inline-flex items-center gap-2 px-3 py-1 text-xs font-medium rounded-full`};
    background-color: var(--color-background);
    border: 1px solid var(--color-neutral);
    color: ${(p) => (p.$tone === 'good' ? '#22c55e' : p.$tone === 'bad' ? '#ef4444' : 'var(--color-muted)')};
`;

export const Tabs = styled.div`
    ${tw`flex gap-1 p-1 mb-4 overflow-x-auto`};
    background-color: var(--color-background-secondary);
    border: 1px solid var(--color-neutral);
    border-radius: var(--border-radius, 12px);
`;

export const Tab = styled.button<{ $active: boolean }>`
    ${tw`flex items-center gap-2 px-4 py-2 text-sm font-medium whitespace-nowrap`};
    border-radius: calc(var(--border-radius, 12px) * 0.67);
    color: var(--color-muted);
    transition: all 150ms ease-in-out;

    &:hover {
        color: var(--color-base);
    }

    ${(p) =>
        p.$active &&
        css`
            background-color: var(--color-primary);
            color: var(--color-base);
        `};
`;

export const ListItem = styled.div`
    ${tw`flex items-center gap-3 px-3 py-2`};
    background-color: var(--color-background);
    border-radius: calc(var(--border-radius, 12px) * 0.67);
`;

export const Kpi = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) => (
    <Card>
        <div css={tw`text-xs font-medium uppercase tracking-wide`} style={{ color: 'var(--color-muted)' }}>
            {label}
        </div>
        <div css={tw`mt-1 text-2xl font-bold truncate`} style={{ color: 'var(--color-base)' }}>
            {value}
        </div>
        {sub && (
            <div css={tw`text-xs truncate`} style={{ color: 'var(--color-muted)' }}>
                {sub}
            </div>
        )}
    </Card>
);

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div css={tw`mb-4`}>
        <label css={tw`block mb-1 text-sm font-medium`} style={{ color: 'var(--color-base)' }}>
            {label}
        </label>
        {children}
        {hint && (
            <p css={tw`mt-1 text-xs`} style={{ color: 'var(--color-muted)' }}>
                {hint}
            </p>
        )}
    </div>
);

/** An image that steps aside (for `fallback`) when it cannot be loaded, instead of showing a broken icon. */
export const Picture = ({
    src,
    style,
    fallback = null,
}: {
    src?: string | null;
    style: React.CSSProperties;
    fallback?: React.ReactNode;
}) => {
    const [broken, setBroken] = React.useState(false);
    React.useEffect(() => setBroken(false), [src]);
    if (!src || broken) return <>{fallback}</>;
    return <img src={src} alt={''} style={{ ...style, objectFit: 'cover' }} onError={() => setBroken(true)} />;
};

export const Avatar = ({ url, name, size = 40 }: { url: string | null; name: string; size?: number }) => {
    const style = {
        width: size,
        height: size,
        borderRadius: 'calc(var(--border-radius, 12px) * 0.67)',
        flex: 'none' as const,
    };
    const initials = name
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
    return (
        <Picture
            src={url}
            style={style}
            fallback={
                <div
                    css={tw`flex items-center justify-center text-sm font-bold`}
                    style={{
                        ...style,
                        backgroundColor: 'var(--color-background)',
                        color: 'var(--color-muted)',
                    }}
                >
                    {initials}
                </div>
            }
        />
    );
};

// ---------- Setting controls ----------

const label = (o: DittoOption) => (o.parent ? `${o.name} · ${o.parent}` : o.name);

export const SingleSelect = ({
    options,
    value,
    onChange,
    none = '— None —',
}: {
    options: DittoOption[];
    value: string | null;
    onChange: (values: string[]) => void;
    none?: string;
}) => (
    <Select value={value ?? ''} onChange={(e) => onChange(e.currentTarget.value ? [e.currentTarget.value] : [])}>
        <option value={''}>{none}</option>
        {options.map((o) => (
            <option key={o.id} value={o.id}>
                {label(o)}
            </option>
        ))}
    </Select>
);

export const NumberSelect = ({
    choices,
    value,
    format,
    onChange,
}: {
    choices: number[];
    value: number;
    format: (n: number) => string;
    onChange: (values: string[]) => void;
}) => (
    <Select value={String(value)} onChange={(e) => onChange([e.currentTarget.value])}>
        {choices.map((n) => (
            <option key={n} value={String(n)}>
                {format(n)}
            </option>
        ))}
    </Select>
);

const Chip = styled.span`
    ${tw`inline-flex items-center gap-2 py-1 pl-3 pr-1 text-sm rounded-full`};
    background-color: var(--color-background);
    border: 1px solid var(--color-neutral);
    color: var(--color-base);

    & > button {
        ${tw`w-5 h-5 rounded-full text-xs`};
        color: var(--color-muted);
    }
`;

export const MultiSelect = ({
    options,
    values,
    onChange,
}: {
    options: DittoOption[];
    values: string[];
    onChange: (values: string[]) => void;
}) => {
    const chosen = values.map((v) => options.find((o) => o.id === v)).filter((o): o is DittoOption => !!o);
    const rest = options.filter((o) => !values.includes(o.id));
    return (
        <div>
            {chosen.length > 0 && (
                <div css={tw`flex flex-wrap gap-2 mb-2`}>
                    {chosen.map((o) => (
                        <Chip key={o.id}>
                            {o.name}
                            <button
                                type={'button'}
                                title={'Remove'}
                                onClick={() => onChange(values.filter((v) => v !== o.id))}
                            >
                                ✕
                            </button>
                        </Chip>
                    ))}
                </div>
            )}
            <Select value={''} onChange={(e) => e.currentTarget.value && onChange([...values, e.currentTarget.value])}>
                <option value={''}>{rest.length ? '+ Add…' : 'Nothing else to add'}</option>
                {rest.map((o) => (
                    <option key={o.id} value={o.id}>
                        {label(o)}
                    </option>
                ))}
            </Select>
        </div>
    );
};

export const Toggle = ({
    label: text,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: (on: boolean) => void;
}) => (
    <label css={tw`flex items-center gap-3 mb-3 cursor-pointer select-none`} style={{ color: 'var(--color-base)' }}>
        <input
            type={'checkbox'}
            checked={checked}
            onChange={(e) => onChange(e.currentTarget.checked)}
            css={tw`w-4 h-4`}
        />
        {text}
    </label>
);

// ---------- Formatting ----------

export function formatTime(sec: number | null | undefined) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '—';
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function formatUptime(ms: number) {
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
}

/** Renders **bold**, `code`, channel, role and member mentions and <t:time> from Ditto's log lines. */
export function DiscordText({ text, guild }: { text: string; guild: DittoGuild }) {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|<#\d+>|<@&\d+>|<@!?\d+>|<t:\d+(?::[a-zA-Z])?>)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let k = 0;
    const mention = (t: string) => (
        <span
            key={k++}
            css={tw`px-1 rounded`}
            style={{
                backgroundColor: 'var(--color-background)',
                color: 'var(--color-primary)',
            }}
        >
            {t}
        </span>
    );
    while ((match = re.exec(text))) {
        if (match.index > last) parts.push(text.slice(last, match.index));
        const tok = match[0];
        if (tok.startsWith('**')) parts.push(<b key={k++}>{tok.slice(2, -2)}</b>);
        else if (tok.startsWith('`')) parts.push(<code key={k++}>{tok.slice(1, -1)}</code>);
        else if (tok.startsWith('<#')) {
            const id = tok.slice(2, -1);
            const c = [...guild.options.textChannels, ...guild.options.voiceChannels].find((x) => x.id === id);
            parts.push(mention(`#${c ? c.name : 'channel'}`));
        } else if (tok.startsWith('<@&')) {
            const r = guild.options.roles.find((x) => x.id === tok.slice(3, -1));
            parts.push(mention(`@${r ? r.name : 'role'}`));
        } else if (tok.startsWith('<@')) parts.push(mention('@member'));
        else parts.push(new Date(Number(tok.slice(3).split(/[:>]/)[0]) * 1000).toLocaleString());
        last = match.index + tok.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return <>{parts}</>;
}

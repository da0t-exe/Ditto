import React from 'react';
import styled from 'styled-components/macro';
import tw from 'twin.macro';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { IconDefinition } from '@fortawesome/free-solid-svg-icons';
import Label from '@/components/elements/Label';
import Select from '@/components/elements/Select';
import Switch from '@/components/elements/Switch';
import { DittoGuild, DittoOption } from '@/api/server/ditto';

/* Ditto addon: the pieces the Ditto pages are built from, drawn like Luna's own pages
   (the server dashboard's cards, the settings forms) with the theme's colour variables. */

export const Card = styled.div`
    background-color: var(--color-background-secondary);
    border: 1px solid var(--color-neutral);
    border-radius: var(--border-radius, 8px);
    overflow: hidden;
`;

export const CardBody = styled.div`
    ${tw`p-4`};
`;

export const CardHeader = ({
    icon,
    title,
    children,
}: {
    icon?: IconDefinition;
    title: React.ReactNode;
    children?: React.ReactNode;
}) => (
    <div css={tw`flex items-center gap-3 px-4 py-3`} style={{ borderBottom: '1px solid var(--color-neutral)' }}>
        {icon && <FontAwesomeIcon icon={icon} fixedWidth style={{ color: 'var(--color-primary)' }} />}
        <span css={tw`font-medium truncate`} style={{ color: 'var(--color-base)' }}>
            {title}
        </span>
        {children && <div css={tw`flex items-center gap-2 ml-auto`}>{children}</div>}
    </div>
);

/** A card with a title bar, like the boxes of Luna's server dashboard. */
export const Box = ({
    icon,
    title,
    actions,
    className,
    children,
}: {
    icon?: IconDefinition;
    title: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
    children: React.ReactNode;
}) => (
    <Card className={className}>
        <CardHeader icon={icon} title={title}>
            {actions}
        </CardHeader>
        <CardBody>{children}</CardBody>
    </Card>
);

export const Muted = styled.span`
    color: var(--color-muted);
`;

/** A row of a list inside a card, separated like the rows of Luna's server information box. */
export const Line = styled.div`
    ${tw`flex items-center gap-3 py-3`};
    border-bottom: 1px solid var(--color-neutral);

    &:first-child {
        ${tw`pt-0`};
    }

    &:last-child {
        ${tw`pb-0`};
        border-bottom: none;
    }
`;

/** Shown in a card that has nothing to list yet. */
export const Empty = ({ icon, children }: { icon: IconDefinition; children: React.ReactNode }) => (
    <div
        css={tw`flex flex-col items-center gap-3 px-4 py-8 text-center text-sm`}
        style={{ color: 'var(--color-muted)' }}
    >
        <FontAwesomeIcon icon={icon} size={'2x'} style={{ opacity: 0.5 }} />
        <div>{children}</div>
    </div>
);

export const Dot = ({ on }: { on: boolean }) => (
    <span
        css={tw`inline-block w-2 h-2 rounded-full flex-none`}
        style={{
            backgroundColor: on ? '#22c55e' : '#ef4444',
            boxShadow: `0 0 0 3px ${on ? '#22c55e33' : '#ef444433'}`,
        }}
    />
);

export const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div css={tw`mb-5 last:mb-0`}>
        <Label>{label}</Label>
        {children}
        {hint && (
            <p css={tw`mt-2 ml-1 text-xs`} style={{ color: 'var(--color-muted)' }}>
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
    const style = { width: size, height: size, borderRadius: '9999px', flex: 'none' as const };
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
                    css={tw`flex items-center justify-center font-bold`}
                    style={{ ...style, backgroundColor: 'var(--color-primary)', color: '#fff', fontSize: size * 0.4 }}
                >
                    {initials}
                </div>
            }
        />
    );
};

// ---------- Setting controls: each change is saved at once ----------

const optionLabel = (o: DittoOption) => (o.parent ? `${o.name} · ${o.parent}` : o.name);

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
                {optionLabel(o)}
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
    ${tw`inline-flex items-center gap-1 py-1 pl-3 pr-1 text-sm`};
    background-color: color-mix(in srgb, var(--color-primary) 18%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-primary) 45%, transparent);
    border-radius: 9999px;
    color: var(--color-base);

    & > button {
        ${tw`flex items-center justify-center w-5 h-5 text-xs rounded-full`};
        color: var(--color-muted);

        &:hover {
            color: var(--color-base);
            background-color: var(--color-neutral);
        }
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
                                title={`Remove ${o.name}`}
                                onClick={() => onChange(values.filter((v) => v !== o.id))}
                            >
                                ✕
                            </button>
                        </Chip>
                    ))}
                </div>
            )}
            <Select value={''} onChange={(e) => e.currentTarget.value && onChange([...values, e.currentTarget.value])}>
                <option value={''}>{rest.length ? 'Add…' : 'Nothing else to add'}</option>
                {rest.map((o) => (
                    <option key={o.id} value={o.id}>
                        {optionLabel(o)}
                    </option>
                ))}
            </Select>
        </div>
    );
};

/** Luna's switch, kept in step with the value Ditto has saved. */
export const Toggle = ({
    name,
    label,
    description,
    checked,
    onChange,
}: {
    name: string;
    label: string;
    description?: string;
    checked: boolean;
    onChange: (on: boolean) => void;
}) => (
    <div css={tw`mb-5 last:mb-0`}>
        <Switch
            key={String(checked)}
            name={name}
            label={label}
            description={description}
            defaultChecked={checked}
            onChange={(e) => onChange(e.currentTarget.checked)}
        />
    </div>
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

export function timeAgo(at: number) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(at).toLocaleDateString();
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
                backgroundColor: 'color-mix(in srgb, var(--color-primary) 18%, transparent)',
                color: 'var(--color-base)',
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

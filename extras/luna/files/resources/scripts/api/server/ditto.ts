import axios from 'axios';
import { httpErrorToHuman } from '@/api/http';

/**
 * Ditto addon: talks to the Ditto bot running on a server, through the panel
 * (/api/client/servers/{uuid}/ditto/…), which forwards the request to the bot's
 * dashboard API on the server's main port.
 *
 * The panel logs people in to Ditto by itself. Only when it cannot (an older Ditto)
 * do the pages ask for Ditto's password; that login is then kept in this browser.
 *
 * A separate client from the panel's own, so the pages can refresh every few
 * seconds without flashing the panel's progress bar.
 */
const client = axios.create({
    withCredentials: true,
    timeout: 25000,
    headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
        'Content-Type': 'application/json',
    },
});

export class DittoError extends Error {
    constructor(message: string, public status: number, public code?: string) {
        super(message);
    }
}

const tokenKey = (uuid: string) => `ditto:token:${uuid}`;

/** A login made with Ditto's password in this browser, if any. */
export function dittoToken(uuid: string): string | null {
    try {
        return localStorage.getItem(tokenKey(uuid));
    } catch {
        return null;
    }
}

export function setDittoToken(uuid: string, token: string | null) {
    try {
        if (token) localStorage.setItem(tokenKey(uuid), token);
        else localStorage.removeItem(tokenKey(uuid));
    } catch {
        /* private mode */
    }
}

export default function ditto<T = any>(
    uuid: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    data?: unknown
): Promise<T> {
    const token = dittoToken(uuid);
    return client
        .request<T>({
            url: `/api/client/servers/${uuid}/ditto/${path}`,
            method,
            data: method === 'get' ? undefined : data ?? {},
            headers: token ? { 'X-Ditto-Token': token } : {},
        })
        .then((response) => response.data)
        .catch((error) => {
            throw new DittoError(httpErrorToHuman(error), error.response?.status ?? 0, error.response?.data?.code);
        });
}

// ---------- What Ditto answers ----------

export interface DittoGuildSummary {
    id: string;
    name: string;
    icon: string | null;
    members: number;
    playing: boolean;
}

export interface DittoMe {
    admin: boolean;
    user: { id: string; name: string; avatar: string } | null;
    bot: {
        name: string;
        avatar: string | null;
        version: string;
        uptime: number;
        ping: number;
        servers: number;
        members: number;
        memoryMb: number;
        music: boolean;
        photos: number;
        /** Adds the bot to a Discord server (Ditto 0.6 and later). */
        invite?: string | null;
    };
    guilds: DittoGuildSummary[];
}

export interface DittoOption {
    id: string;
    name: string;
    parent?: string | null;
    color?: string;
    /** A stage channel: music can play there, but it cannot be a room. */
    stage?: boolean;
    /** People in a voice channel right now. */
    listeners?: number;
}

export interface DittoConfig {
    memberRole: string | null;
    pendingRole: string | null;
    verifyChannel: string | null;
    quarantineRole: string | null;
    quarantineBots: string[];
    logChannel: string | null;
    staffRoles: string[];
    rooms: string[];
    voiceLog: boolean;
    autoAfk: boolean;
    afkIdleMinutes: number;
    captchaAttempts: number;
    captchaTimeoutMinutes: number;
}

export interface DittoTrack {
    title: string;
    author: string;
    duration: number | null;
    thumbnail: string | null;
    link: string;
    source: string;
    live: boolean;
    requester: string | null;
}

export interface DittoMusic {
    current: DittoTrack | null;
    position: number;
    paused: boolean;
    volume: number;
    loop: 'off' | 'track' | 'queue';
    filter: string;
    channel: string | null;
    queue: DittoTrack[];
    queueLength: number;
}

export type DittoCaptchaEvent = 'join' | 'pass' | 'fail' | 'lockout' | 'quarantine';

export interface DittoGuild {
    id: string;
    name: string;
    icon: string | null;
    members: number;
    config: DittoConfig;
    verification: boolean;
    options: {
        roles: DittoOption[];
        textChannels: DittoOption[];
        voiceChannels: DittoOption[];
        bots: DittoOption[];
    };
    warnings: string[];
    captcha: {
        totals: Record<DittoCaptchaEvent, number>;
        days: { day: string; event: DittoCaptchaEvent; n: number }[];
        latest: {
            user_id: string;
            event: DittoCaptchaEvent;
            at: number;
            name: string | null;
        }[];
    };
    locks: {
        channelId: string;
        channel: string;
        members: number;
        expiresAt: number | null;
        createdBy: string;
    }[];
    music: DittoMusic | null;
    logs: { at: number; text: string }[];
}

export interface DittoLive {
    music: DittoMusic | null;
    logs: { at: number; text: string }[];
    locks: number;
}

import { useEffect, useReducer } from 'react';
import ditto, {
    DittoConfig,
    DittoError,
    DittoGuild,
    DittoLive,
    DittoMe,
    dittoToken,
    setDittoToken,
} from '@/api/server/ditto';

/**
 * Ditto addon: what the Ditto pages share. Each page of the Ditto section is its own
 * panel route, so this lives outside React: going from one page to another shows the
 * data at once and refreshes it quietly.
 */

export type DittoStatus = 'loading' | 'login' | 'down' | 'ready';

export interface DittoState {
    status: DittoStatus;
    /** Why Ditto cannot be reached, when status is "down". */
    problem: string;
    me: DittoMe | null;
    guildId: string | null;
    guild: DittoGuild | null;
    /** Logged in with Ditto's password in this browser, rather than by the panel. */
    manual: boolean;
}

type Notify = (message: string, type?: 'success' | 'error') => void;

const remember = (key: string, value?: string) => {
    try {
        if (value === undefined) return localStorage.getItem(key);
        localStorage.setItem(key, value);
    } catch {
        /* private mode */
    }
    return null;
};

export class DittoStore {
    state: DittoState;
    notify: Notify = () => undefined;
    private listeners = new Set<() => void>();
    private timer?: number;
    private loadedAt = 0;

    constructor(public readonly uuid: string) {
        this.state = {
            status: 'loading',
            problem: '',
            me: null,
            guildId: remember(`ditto:guild:${uuid}`),
            guild: null,
            manual: !!dittoToken(uuid),
        };
    }

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        if (this.listeners.size === 1) this.poll();
        if (this.state.status !== 'ready') this.load();
        else if (Date.now() - this.loadedAt > 15000) this.load(true);
        return () => {
            this.listeners.delete(listener);
            if (!this.listeners.size) window.clearInterval(this.timer);
        };
    }

    private set(patch: Partial<DittoState>) {
        this.state = { ...this.state, ...patch };
        this.listeners.forEach((l) => l());
    }

    private fail = (err: DittoError) => {
        if (err.status === 401 && dittoToken(this.uuid)) {
            // The password login of this browser ended: let the panel log in instead.
            setDittoToken(this.uuid, null);
            this.load();
        } else if (err.status === 401) {
            this.set({ status: 'login', manual: false });
        } else if (err.code === 'unreachable' || err.code === 'not_ditto') {
            this.set({ status: 'down', problem: err.message });
        } else {
            this.notify(err.message, 'error');
        }
    };

    /** Who Ditto is and which Discord servers it manages, then the chosen server. */
    load = (quiet = false) => {
        if (!quiet) this.set({ status: 'loading' });
        return ditto<DittoMe>(this.uuid, 'get', 'me')
            .then((me) => {
                const { guildId } = this.state;
                const id = me.guilds.some((g) => g.id === guildId) ? guildId : me.guilds[0]?.id ?? null;
                this.loadedAt = Date.now();
                this.set({ me, guildId: id, status: 'ready', manual: !!dittoToken(this.uuid) });
                return id ? this.loadGuild(id) : undefined;
            })
            .catch(this.fail);
    };

    loadGuild = (id = this.state.guildId) => {
        if (!id) return Promise.resolve();
        return ditto<DittoGuild>(this.uuid, 'get', `guilds/${id}`)
            .then((guild) => {
                if (this.state.guildId === id) this.set({ guild });
            })
            .catch(this.fail);
    };

    pick = (id: string) => {
        remember(`ditto:guild:${this.uuid}`, id);
        this.set({ guildId: id, guild: null });
        this.loadGuild(id);
    };

    /** Music and logs change on their own: refresh them every few seconds while a page is open. */
    private poll() {
        window.clearInterval(this.timer);
        this.timer = window.setInterval(() => {
            const { guild, status } = this.state;
            if (document.hidden || status !== 'ready' || !guild) return;
            ditto<DittoLive>(this.uuid, 'get', `guilds/${guild.id}/live`)
                .then((live) => {
                    const g = this.state.guild;
                    if (g && g.id === guild.id) this.set({ guild: { ...g, music: live.music, logs: live.logs } });
                })
                .catch(() => undefined);
        }, 4000);
    }

    private call<T = any>(method: 'post' | 'patch' | 'delete', rest: string, body?: unknown) {
        return ditto<T>(this.uuid, method, `guilds/${this.state.guildId}/${rest}`, body);
    }

    login = (password: string, isCode: boolean) =>
        ditto<{ token: string }>(
            this.uuid,
            'post',
            isCode ? 'login/link' : 'login',
            isCode ? { code: password.trim() } : { password }
        ).then(({ token }) => {
            setDittoToken(this.uuid, token);
            return this.load();
        });

    logout = () => {
        ditto(this.uuid, 'post', 'logout').catch(() => undefined);
        setDittoToken(this.uuid, null);
        this.set({ me: null, guild: null, manual: false });
        this.load();
    };

    save = (field: string, values: string[]) =>
        this.call<DittoConfig>('patch', 'config', { field, values })
            .then((config) => {
                const g = this.state.guild;
                if (g) this.set({ guild: { ...g, config } });
                this.notify('Saved.');
                return this.loadGuild();
            })
            .catch(this.fail);

    run = (action: 'quick-setup' | 'detect' | 'panel') =>
        this.call<any>('post', `actions/${action}`)
            .then((r) => {
                if (action === 'quick-setup')
                    this.notify(`Done: ${r.created.length} created, ${r.hidden} channel(s) hidden from newcomers.`);
                else if (action === 'detect')
                    this.notify(r.filled.length ? `Filled ${r.filled.length} setting(s).` : 'Nothing new found.');
                else
                    this.notify(
                        r.posted ? 'Verify panel posted.' : 'There is no verification channel yet.',
                        r.posted ? 'success' : 'error'
                    );
                return this.loadGuild();
            })
            .catch(this.fail);

    music = (action: string, body?: Record<string, unknown>) =>
        this.call<any>('post', `music/${action}`, body ?? {})
            .then((r) => {
                if (action === 'play')
                    this.notify(
                        r.added > 1
                            ? `Added ${r.added} tracks.`
                            : r.position === 0
                            ? 'Playing.'
                            : `Added — #${r.position} in the queue.`
                    );
                window.setTimeout(() => this.loadGuild(), action === 'play' ? 1500 : 300);
            })
            .catch(this.fail);

    unlock = (channelId: string) =>
        this.call('delete', `locks/${channelId}`)
            .then(() => {
                this.notify('Unlocked.');
                return this.loadGuild();
            })
            .catch(this.fail);
}

const stores = new Map<string, DittoStore>();

/** The Ditto store of this panel server; the calling component redraws when it changes. */
export function useDitto(uuid: string): DittoStore {
    let store = stores.get(uuid);
    if (!store) {
        store = new DittoStore(uuid);
        stores.set(uuid, store);
    }
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    useEffect(() => store!.subscribe(redraw), [store]);
    return store;
}

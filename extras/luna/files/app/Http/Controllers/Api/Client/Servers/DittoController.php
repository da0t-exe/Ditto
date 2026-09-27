<?php

namespace Pterodactyl\Http\Controllers\Api\Client\Servers;

use Illuminate\Support\Str;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Http\Client\Response;
use Illuminate\Http\Client\ConnectionException;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\Permission;
use Pterodactyl\Repositories\Wings\DaemonCommandRepository;
use Pterodactyl\Http\Requests\Api\Client\ClientApiRequest;
use Pterodactyl\Http\Controllers\Api\Client\ClientApiController;
use Pterodactyl\Exceptions\Http\Connection\DaemonConnectionException;

/**
 * Ditto addon: forwards the Ditto pages' requests to the dashboard API that the Ditto
 * Discord bot serves on this server's main allocation.
 *
 * Only Ditto's API paths are forwarded, and only JSON comes back: the pages ship with
 * the panel, so nothing the server answers can run as a panel page.
 *
 * Logging in: people who can use this server's console are logged in to Ditto for them.
 * The panel types a one-time code in the console (as they could), Ditto trades it for a
 * session, and the panel keeps that session; the browser never sees it. When that is not
 * possible (an older Ditto, DASHBOARD_CONSOLE_LOGIN=0), the pages ask for Ditto's password.
 */
class DittoController extends ClientApiController
{
    /** Every path of Ditto's dashboard API. */
    private const PATHS = '#^(me|login|login/link|logout|guilds/\d{15,21}(/(live|config|actions/[a-z-]{1,30}|music/[a-z]{1,20}|locks/\d{15,21}))?)$#';

    /** Ditto keeps a panel session for a day; the panel stops using it a bit sooner. */
    private const SESSION_MINUTES = 12 * 60;

    public function __construct(private DaemonCommandRepository $console)
    {
        parent::__construct();
    }

    public function proxy(ClientApiRequest $request, Server $server, string $path = ''): JsonResponse
    {
        if (!$request->user()->can(Permission::ACTION_CONTROL_CONSOLE, $server)) {
            return new JsonResponse(['error' => 'You need access to this server\'s console to manage Ditto.'], 403);
        }

        if (!preg_match(self::PATHS, $path)) {
            return new JsonResponse(['error' => 'Not found'], 404);
        }

        $base = $this->baseUrl($server);
        if (!$base) {
            return new JsonResponse(['error' => 'This server has no port.', 'code' => 'unreachable'], 502);
        }

        $method = strtoupper($request->method());
        $body = $method === 'GET' ? null : $request->json()->all();

        try {
            // Logged in with Ditto's password in this browser.
            $token = $request->header('X-Ditto-Token');
            if (is_string($token) && $token !== '' && strlen($token) <= 200) {
                return $this->reply($this->forward($base, $method, $path, $body, $token));
            }

            if (in_array($path, ['login', 'login/link'], true)) {
                return $this->reply($this->forward($base, $method, $path, $body, null));
            }

            // Logged in by the panel.
            $key = sprintf('ditto:session:%s:%d', $server->uuid, $request->user()->id);
            if ($path === 'logout') {
                Cache::forget($key);

                return new JsonResponse(['ok' => true]);
            }

            $saved = Cache::get($key);
            $token = is_string($saved) ? rescue(fn () => Crypt::decryptString($saved), null, false) : null;
            $fresh = false;
            if (!$token) {
                $token = $this->consoleLogin($server, $request, $base, $key);
                $fresh = true;
            }
            if (!$token) {
                return new JsonResponse(['error' => 'Please log in', 'code' => 'login'], 401);
            }

            $response = $this->forward($base, $method, $path, $body, $token);
            if ($response->status() === 401 && !$fresh) {
                // Ditto forgot the session (its data was reset): log in again, once.
                Cache::forget($key);
                $token = $this->consoleLogin($server, $request, $base, $key);
                if (!$token) {
                    return new JsonResponse(['error' => 'Please log in', 'code' => 'login'], 401);
                }
                $response = $this->forward($base, $method, $path, $body, $token);
            }

            return $this->reply($response);
        } catch (ConnectionException) {
            return new JsonResponse([
                'error' => sprintf('Ditto does not answer on %s. Is the bot running on this server?', parse_url($base, PHP_URL_HOST) . ':' . parse_url($base, PHP_URL_PORT)),
                'code' => 'unreachable',
            ], 502);
        }
    }

    /** http://<primary allocation>/api, or the node's address when the allocation listens everywhere. */
    private function baseUrl(Server $server): ?string
    {
        $allocation = $server->allocation;
        if (!$allocation) {
            return null;
        }

        $host = in_array($allocation->ip, ['0.0.0.0', '::'], true) ? $server->node->fqdn : $allocation->ip;
        if (str_contains($host, ':')) {
            $host = "[{$host}]";
        }

        return sprintf('http://%s:%d/api', $host, $allocation->port);
    }

    private function forward(string $base, string $method, string $path, ?array $body, ?string $token): Response
    {
        $pending = Http::timeout(20)->acceptJson();
        if ($token) {
            $pending = $pending->withToken($token);
        }

        return $method === 'GET'
            ? $pending->get("{$base}/{$path}")
            : $pending->send($method, "{$base}/{$path}", ['json' => $body ?: new \stdClass()]);
    }

    private function reply(Response $response): JsonResponse
    {
        $data = $response->json();
        if (!is_array($data)) {
            return new JsonResponse(['error' => 'This server does not answer like Ditto.', 'code' => 'not_ditto'], 502);
        }

        return new JsonResponse($data, $response->status());
    }

    /**
     * Types a one-time code in the server's console and trades it with Ditto for a
     * session. After a failure, the pages ask for the password for a minute before
     * this is tried again.
     */
    private function consoleLogin(Server $server, ClientApiRequest $request, string $base, string $key): ?string
    {
        if (Cache::has("{$key}:off")) {
            return null;
        }

        $code = Str::random(48);
        try {
            $this->console->setServer($server)->send("ditto-panel-login {$code}");
            $response = Http::timeout(10)->acceptJson()->post("{$base}/login/console", [
                'code' => $code,
                'name' => $request->user()->username,
            ]);
        } catch (DaemonConnectionException) {
            $response = null;
        }

        $token = $response?->successful() ? $response->json('token') : null;
        if (!is_string($token) || $token === '') {
            Cache::put("{$key}:off", true, now()->addMinute());

            return null;
        }

        Cache::put($key, Crypt::encryptString($token), now()->addMinutes(self::SESSION_MINUTES));

        return $token;
    }
}

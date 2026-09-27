<?php

namespace Pterodactyl\Http\Controllers\Api\Client\Servers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Http;
use Illuminate\Http\Client\ConnectionException;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\Permission;
use Pterodactyl\Http\Requests\Api\Client\ClientApiRequest;
use Pterodactyl\Http\Controllers\Api\Client\ClientApiController;

/**
 * Ditto addon: forwards the Ditto tab's requests to the dashboard API that the Ditto
 * Discord bot serves on this server's main allocation.
 *
 * Only Ditto's API paths are forwarded, and only JSON comes back: the page itself
 * ships with the panel, so nothing the server answers can run as a panel page.
 */
class DittoController extends ClientApiController
{
    /** Every path of Ditto's dashboard API. */
    private const PATHS = '#^(me|login|login/link|logout|guilds/\d{15,21}(/(live|config|actions/[a-z-]{1,30}|music/[a-z]{1,20}|locks/\d{15,21}))?)$#';

    public function proxy(ClientApiRequest $request, Server $server, string $path = ''): JsonResponse
    {
        if (!$request->user()->can(Permission::ACTION_CONTROL_CONSOLE, $server)) {
            return new JsonResponse(['error' => 'You need access to this server\'s console to manage Ditto.'], 403);
        }

        if (!preg_match(self::PATHS, $path)) {
            return new JsonResponse(['error' => 'Not found'], 404);
        }

        $allocation = $server->allocation;
        if (!$allocation) {
            return new JsonResponse(['error' => 'This server has no port.', 'code' => 'unreachable'], 502);
        }

        // Allocations bound to every address are reached through the node's own address.
        $host = in_array($allocation->ip, ['0.0.0.0', '::'], true) ? $server->node->fqdn : $allocation->ip;
        if (str_contains($host, ':')) {
            $host = "[{$host}]";
        }
        $url = sprintf('http://%s:%d/api/%s', $host, $allocation->port, $path);

        $pending = Http::timeout(20)->acceptJson();
        $token = $request->header('X-Ditto-Token');
        if (is_string($token) && $token !== '' && strlen($token) <= 200) {
            $pending = $pending->withToken($token);
        }

        try {
            $method = strtoupper($request->method());
            if ($method === 'GET') {
                $response = $pending->get($url);
            } else {
                $body = $request->json()->all();
                $response = $pending->send($method, $url, ['json' => $body ?: new \stdClass()]);
            }
        } catch (ConnectionException) {
            return new JsonResponse([
                'error' => "Ditto does not answer on {$host}:{$allocation->port}. Is the bot running on this server?",
                'code' => 'unreachable',
            ], 502);
        }

        $data = $response->json();
        if (!is_array($data)) {
            return new JsonResponse(['error' => 'This server does not answer like Ditto.', 'code' => 'not_ditto'], 502);
        }

        return new JsonResponse($data, $response->status());
    }
}

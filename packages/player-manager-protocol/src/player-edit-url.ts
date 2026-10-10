import type {PlayerId} from "./player.js";

export function playerEditUrl(playerId: PlayerId): string {
	if (!playerId) throw new TypeError("playerId must not be empty");
	return `/bundles/player-manager/dashboard/PlayerMapping.html?standalone=true&playerId=${encodeURIComponent(playerId)}`;
}

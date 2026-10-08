/**
 * Coarse user-agent classification — the same browser/OS mapping as
 * @autter/runtime-browser (family + major version, OS family), plus a
 * device class. Never stores the raw user agent.
 */
export interface UserAgentInfo {
	browser: string;
	os: string;
	device: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
	bot: boolean;
}

const BOT =
	/bot\b|crawler|spider|crawling|slurp|headless|lighthouse|curl\/|wget\/|python-requests|httpclient|okhttp|go-http-client|axios\/|node-fetch|undici/i;

export function parseUserAgent(ua: string | undefined | null): UserAgentInfo {
	const value = String(ua ?? "").slice(0, 512);
	const os = /Windows/.test(value)
		? "Windows"
		: /Android/.test(value)
			? "Android"
			: /iPhone|iPad|iPod/.test(value)
				? "iOS"
				: /Mac OS X/.test(value)
					? "macOS"
					: /CrOS/.test(value)
						? "ChromeOS"
						: /Linux/.test(value)
							? "Linux"
							: "";
	const edge = /Edg\/(\d+)/.exec(value);
	const firefox = /Firefox\/(\d+)/.exec(value);
	const chrome = /Chrome\/(\d+)/.exec(value);
	const safari = /Version\/(\d+).+Safari/.exec(value);
	const browser = edge
		? `Edge ${edge[1]}`
		: firefox
			? `Firefox ${firefox[1]}`
			: chrome
				? `Chrome ${chrome[1]}`
				: safari
					? `Safari ${safari[1]}`
					: "";
	const bot = BOT.test(value);
	const device = !value
		? "unknown"
		: bot
			? "bot"
			: /iPad|Tablet/.test(value) || (/Android/.test(value) && !/Mobile/.test(value))
				? "tablet"
				: /Mobi|iPhone|iPod|Android/.test(value)
					? "mobile"
					: "desktop";
	return { browser, os, device, bot };
}

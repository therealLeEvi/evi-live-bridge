// The one User-Agent every outbound request from EVI carries.
//
// The OSRS Wiki asks tools to identify themselves, and the reason to comply is practical rather than
// polite: an API owner who can tell what a client is, and reach whoever runs it, asks before blocking.
// Their own guidance gives the example "volume_tracker - @ThisIsMyUsername on Discord" and lists
// user-agents they block pre-emptively (python-requests, Python-urllib, Apache-HttpClient, RestSharp,
// bare Java/{version} and curl/{version}); nothing here sends any of those, since the bridge always
// names itself and the plugin only ever talks to 127.0.0.1.
//
// So this carries both contacts the Wiki could want: the maintainer's Discord handle, in their
// suggested form, and the repository, where the source and its issue tracker live. Both are the
// project's public contact points, chosen deliberately: this string is sent to a third party on every
// call and the bridge's source is published, so it carries no email address and nothing that is not
// already meant to be public.
//
// One place, because six files had hand-copied their own variant and one still said 3.6 while the
// rest said 3.0 -- a version that drifts per file tells an API owner nothing useful.
// Bump this with the release line. It had drifted to 3.7 while the shipping plugin was 3.8.1 -- the
// exact per-file drift this module was created to end, just slower.
const VERSION = '3.8';
const DISCORD = 'le.evi';
const HOME = 'https://github.com/therealLeEvi/evi-live-bridge';

/** `purpose` names what this particular caller is fetching, e.g. "hourly price archive". */
export function userAgent(purpose) {
  return `EVI-Live/${VERSION} (personal local OSRS market scanner${purpose ? '; ' + purpose : ''}; @${DISCORD} on Discord; +${HOME})`;
}

export const USER_AGENT = userAgent();

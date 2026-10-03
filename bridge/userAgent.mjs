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
//
// IT CARRIES THE RELEASE DATE TAG, not a semver, and that is the fix for a drift this module was
// created to end and then suffered twice itself. The history, 2 Oct 2026: it was written at 3.7,
// bumped once to 3.8 on 27 Sept, and was still 3.8 five releases later while the plugin read 3.11.0
// and the published package.json read 3.6.0 -- three numbers, none agreeing.
//
// The cause was structural, not carelessness. The PLUGIN cannot ship without its version moving:
// the Hub reads `version=` and the manifest pins a commit, so a release is impossible otherwise.
// The BRIDGE is published as a DATE-TAGGED GitHub release (`bridge-2026.10.02`), so nothing in that
// process ever reads a semver -- package.json's version has no consumer at all, which is exactly why
// nobody noticed it freeze. This constant had seven consumers and no gate, so it moved only when
// someone remembered.
//
// "Bump this with the release line" was also ambiguous enough to stop happening: 3.8 was set while
// the PLUGIN was 3.8.1, so it was tracking the plugin, while living in the bridge. The date tag
// removes the ambiguity -- it is literally the tag being published, so it can be CHECKED against it
// at release time, which is the property 3.8 never had. See step 2 of the release order in CLAUDE.md.
//
// Between releases this names the last release, which is honest: the running code is that bridge plus
// whatever is unpushed. It is never a claim about unreleased work.
const RELEASE = '2026.10.03';
const DISCORD = 'le.evi';
const HOME = 'https://github.com/therealLeEvi/evi-live-bridge';

/** `purpose` names what this particular caller is fetching, e.g. "hourly price archive". */
export function userAgent(purpose) {
  return `EVI-Live/${RELEASE} (personal local OSRS market scanner${purpose ? '; ' + purpose : ''}; @${DISCORD} on Discord; +${HOME})`;
}

export const USER_AGENT = userAgent();
/** The release this build identifies itself as, exported so a test can check its shape. */
export const RELEASE_TAG = RELEASE;

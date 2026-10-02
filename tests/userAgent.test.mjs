// The User-Agent is sent to a third party on every outbound request, so its shape is worth a test.
//
// WHY THIS EXISTS. The version in here drifted twice: written at 3.7, bumped once to 3.8, and still
// 3.8 five releases later while the plugin read 3.11.0 and package.json read 3.6.0. The cause was
// that nothing could TELL it was stale -- "3.8" looks exactly as plausible as "3.11". A date tag can
// be read against the release being published, and this test catches the thing that actually went
// wrong: a semver creeping back in.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {userAgent, USER_AGENT, RELEASE_TAG} from '../bridge/userAgent.mjs';

test('user agent: identifies the build by release date tag, not a semver that silently rots', () => {
  // The format the bridge's own releases use (bridge-YYYY.MM.DD), so the constant can be compared
  // against the tag at release time. A semver here is the regression being guarded against.
  assert.match(RELEASE_TAG, /^\d{4}\.\d{2}\.\d{2}[a-z]?$/,
    `the release tag must look like a bridge release date, got "${RELEASE_TAG}"`);
  assert.doesNotMatch(RELEASE_TAG, /^\d+\.\d+$/, 'a bare semver is what drifted twice before');

  // The date has to be a real one, so a typo cannot ship as a plausible-looking tag.
  const [y, m, d] = RELEASE_TAG.split('.').map(v => parseInt(v, 10));
  assert.ok(y >= 2026 && y <= 2100, `implausible year: ${y}`);
  assert.ok(m >= 1 && m <= 12, `impossible month: ${m}`);
  assert.ok(d >= 1 && d <= 31, `impossible day: ${d}`);

  // What the Wiki actually needs: the tool, the build, a contact and a source link. Their guidance
  // names the user-agents they block pre-emptively, so the point is to look like none of them.
  assert.ok(USER_AGENT.startsWith('EVI-Live/'), USER_AGENT);
  assert.ok(USER_AGENT.includes(RELEASE_TAG), 'the build must be identifiable');
  assert.match(USER_AGENT, /@[\w.]+ on Discord/, 'a contact the API owner can reach');
  assert.match(USER_AGENT, /\+https:\/\/github\.com\//, 'a source link');
  for (const blocked of ['python-requests', 'Python-urllib', 'Apache-HttpClient', 'RestSharp', 'curl/']) {
    assert.ok(!USER_AGENT.includes(blocked), `must not look like ${blocked}`);
  }
  // No email address or anything not already public -- this string goes to a third party every call.
  assert.doesNotMatch(USER_AGENT, /@[\w.-]+\.(com|net|org)\b/, 'no email address in the user agent');

  // The purpose is appended so one caller can be told from another in their logs, and omitted cleanly.
  assert.ok(userAgent('price archive').includes('; price archive;'), userAgent('price archive'));
  assert.ok(!userAgent().includes(';;'), 'no empty purpose segment when none is given');
});

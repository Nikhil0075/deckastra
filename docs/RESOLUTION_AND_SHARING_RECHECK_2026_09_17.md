# Resolution and sharing recheck — 2026-09-17

Reviewed commit `189fb11bd5ba5260975354ace23f4419ac3a4abf`, with a clean working tree before this report. Focus: the resolution contract, Share panel capability handling, and the previous bootstrap findings. No production code was changed.

## Result

No new blocker found in this focused review. The previously reported local resolution/acknowledgement defects and bootstrap refusal/paging cases are addressed by the current implementation and targeted tests. This is not closure of the complete D5 synchronization milestone or desktop release acceptance.

## Verified behavior

- `resolves` names the conflict change key, remote version and reviewed local version. The transaction route validates them before writing. The store advances the head with a compare-and-swap against its loaded parent; a concurrent head advance causes a conflict. Queue retirement takes place in the same database transaction, preserves assets and spares the resolving transaction.
- The separate `/sync/reconciled` acknowledgement route is removed, with a regression asserting 404. Ordinary edits do not retire the queue. Resolution-binding and stale-version cases are covered in `apps/api/tests/test_sync_divergence.py`.
- Source comments describe an explicit declaration against validated versions, rather than evidence that anyone read the conflict. This contract does not prove merged-content quality.
- `/v1/account` computes `capabilities.sharing` from `not local_mode.enabled()`. The scope matches the sharing refusal: deployment-wide, independent of workspace origin.
- `SharePanel` distinguishes asking, supported, unsupported and unknown. Unsupported installations do not request share links. Account failures display an inability-to-check message without claiming the workspace is local. Creation is disabled until support is confirmed.
- Bootstrap now stops processing a refused project. HTTP listing follows `next_after` using the stable ID-order path; the default picker ordering remains separate. Bootstrap tests include the route/adapter paging contract.

## Fresh verification

| Command | Result |
| --- | --- |
| `python -m pytest apps/api/tests/test_sync_divergence.py apps/api/tests/test_bootstrap.py apps/api/tests/test_local_mode.py -q --tb=short` | 57 passed |
| `npm exec --workspace @deckastra/editor-ui -- vitest run tests/share-panel.test.tsx` | 4 passed |
| `npm run typecheck --workspace @deckastra/editor-ui` | Passed |

No skips or failures were reported by these selected checks. The user's broader 548-pass/16-skip and full npm-suite results were not independently rerun here.

## Remaining scope

The Share panel has no in-place Retry action after an unknown capability result; reopening/remounting it retries. An explicit retry is a small usability improvement, not a blocker for this correction.

This review did not run the installed application, export it without a development browser cache, inspect pixels, validate PostgreSQL concurrency, or exercise a real two-device sync journey. Real sync transport/receiver behavior, preservation of the resolved state when uploaded against its remote base, and end-to-end collaboration remain separate acceptance work.

Next priority remains packaged export's browser dependency. Verify an installed build with no checkout or Playwright browser cache before closing that release blocker. Saved-theme styling, canvas scrollbars, presenter completeness and startup/memory labels remain runtime/visual review work; they were not changed or reverified here.

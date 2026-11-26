# Shop team API

Owner routes use the cookie session and the `X-Shop-Id` header to select the shop. Writes require the session's CSRF proof. Owner responses containing account details use `Cache-Control: no-store`.

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/shop/team/members` | Returns `{ members }` for the selected shop. Each Member or Admin row has a membership `id`, nullable `fullName`, `email`, and `role`. |
| `PATCH /api/v1/shop/team/members/:membershipId` | Accepts `{ role }` with `member` or `admin` and returns `204`. Repeating the current role has no effect. Owner memberships and IDs outside the selected shop return `404`. |
| `POST /api/v1/shop/team/accounts/search` | Accepts `{ query, page }` and returns `200` with `{ accounts, page, pageCount }`. A trimmed nonblank query matches literal parts of full names and emails case-insensitively. `page` defaults to 1. Results are ordered by email with up to four accounts per page. |
| `GET /api/v1/shop/team/invitations` | Returns `{ invitations }` containing only pending invitations for the selected shop, newest first. |
| `POST /api/v1/shop/team/invitations` | Accepts `{ recipientId, offeredRole }` and returns `201` with `{ invitation }`. The recipient must be an existing account. The offered role is `member` or `admin`. |
| `DELETE /api/v1/shop/team/invitations/:invitationId` | Cancels a pending invitation from the selected shop and returns `204`. |

Each outgoing invitation contains `id`, `recipientId`, `offeredRole`, `fullName`, `email`, and ISO `createdAt`. `fullName` can be `null`. Sending returns `409` if the account already belongs to the selected shop or has a pending invitation there. Sending an invitation leaves shop membership unchanged.

Each search account contains `id`, nullable `fullName`, `email`, and the selected shop's `eligibility` (`eligible`, `member`, or `pending`). Submit the search term in the JSON body so it stays out of URL logging. An empty result page reports `pageCount: 0`.

Inbox routes use the cookie session and work for accounts with zero shops. Writes require the session's CSRF proof. Responses use `Cache-Control: no-store`.

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/shop-invitations` | Returns `{ invitations }` with the signed-in account's pending invitations, newest first. Each entry contains `id`, `shopId`, `shopName`, `offeredRole`, ISO `createdAt`, and nullable ISO `readAt`. |
| `POST /api/v1/shop-invitations/read` | Accepts `{ invitationIds }` with 1–100 displayed invitation IDs. Stamps currently unread pending invitations belonging to the signed-in account. Returns `204` for any valid batch, including repeated, resolved, unknown, or out-of-scope IDs. |
| `POST /api/v1/shop-invitations/:invitationId/accept` | Grants the stored role and returns `200` with `{ membership: { shopId, role } }`. |
| `POST /api/v1/shop-invitations/:invitationId/decline` | Declines the invitation and returns `204`. |

Accept, decline, and cancel return `404` for an invitation outside the caller's scope and `409` when a scoped invitation has already been resolved. Acceptance commits the invitation and membership together.

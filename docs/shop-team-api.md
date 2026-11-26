# Shop team API

Owner routes use the cookie session and the `X-Shop-Id` header to select the shop. Writes require the session's CSRF proof. Owner responses containing account details use `Cache-Control: no-store`.

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/shop/team/invitations` | Returns `{ invitations }` containing only pending invitations for the selected shop, newest first. |
| `POST /api/v1/shop/team/invitations` | Accepts `{ recipientId, offeredRole }` and returns `201` with `{ invitation }`. The recipient must be an existing account. The offered role is `member` or `admin`. |

Each outgoing invitation contains `id`, `recipientId`, `offeredRole`, `fullName`, `email`, and ISO `createdAt`. `fullName` can be `null`. Sending returns `409` if the account already belongs to the selected shop or has a pending invitation there. Sending an invitation leaves shop membership unchanged.

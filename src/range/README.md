# range

Verified HTTP Range transport: every read proves itself with an exact 206 and Content-Range, and adjacent chunks are coalesced into one request.

OVERVIEW §3, Decision 4.

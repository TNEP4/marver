# marver

## Knowledge inbox (check at session start)

`.brain-inbox.json` is a **gitignored, local** projection from Nic's Asteria vault: things he watched
or read that bear on this repo. At the start of a session, or when picking up work after a gap, read it.

- Each item has a `one_line`, a `routed_because`, and a `digest` path **relative to the Asteria vault**
  (`~/Obsidian/Asteria`). Read the digest if the item is relevant to what you are about to do. The full
  transcript is there too when the digest is not enough.
- When you have read one, set `read: true` and `read_at` to the current UTC timestamp.
- It is **disposable**. Do not treat it as source of truth, do not edit anything except the read flags,
  and never commit it. The vault is canonical; this file regenerates from it.
- An empty `items` list means nothing in the vault currently bears on this repo. That is a normal state.

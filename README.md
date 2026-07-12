# info-blog

`info-blog` is a Jekyll Chirpy site for `info.henjini.com`.

The site publishes Korean long-tail informational posts that answer practical search questions around current-as-of facts: policy changes, application requirements, pricing, refunds, service updates, travel rules, troubleshooting, and everyday administration.

## Content Rules

- State the current-as-of date near the top of every post.
- Prefer official sources and clearly mention where readers should re-check facts.
- Treat laws, policies, prices, eligibility, and product features as change-prone.
- Use concrete question-style titles that match real search intent.
- Keep filenames and slugs in lowercase English kebab-case.

## AI Draft Flow

The workflow creates reviewable AI drafts through pull requests:

- `.github/workflows/ai-draft.yml` runs the generator on schedule or manually.
- `scripts/generate-post.mjs` selects a topic from `prompts/info-topics.json`.
- `prompts/info-post.prompt.md` controls the draft structure and tone.
- Generated drafts are written to `_drafts` and opened as pull requests.

### Priority Keywords

Add urgent or manually selected keywords to `prompts/info-topics.json`:

```json
{
  "priorityKeywords": [
    {
      "keyword": "2026년 청년도약계좌 소득 조건",
      "used": false,
      "usedAt": null
    }
  ]
}
```

Unused priority keywords are selected before the normal topic queue. After one is selected, the generator marks it with `used: true` and `usedAt`.

## Local Notes

The site uses the Chirpy theme. Install dependencies before building locally.

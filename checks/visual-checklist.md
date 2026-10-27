# Visual review checklist

The `visual-reviewer` scores every item as PASS / FAIL with one line of evidence
(which screenshot, where on it). Add items here whenever a rebuild-vs-handmade
comparison shows something the pipeline missed. That's how the reviewer gets better.

## Brand match
- [ ] Colors on screen match `project.json → brand.colors` exactly; no extra hues invented.
- [ ] The real logo from `assets/` is used, not redrawn, recolored or stretched.
- [ ] Heading and body fonts match `brand.fonts` (or one consistent fallback if blank).
- [ ] Client's real photos are used where provided; stock images aren't passed off as theirs.
- [ ] Tone of copy matches `brief.tone` and the language(s) in `specs.languages`.

## Generic / template feel
- [ ] The hero says what *this* business does and where, not a slogan that fits any company.
- [ ] No placeholder text ("Lorem ipsum", "Your Company", "Service 1"), no fake stats or testimonials.
- [ ] Layout doesn't fall back to the default AI look: centered hero + 3 identical icon cards + gradient blob.
- [ ] At least one element is specific to the client (their team, location, real work, prices, niche detail from `niches/<niche>.md`).
- [ ] Section order follows what the client's customers need (see the niche file), not a fixed template.

## Hierarchy & readability
- [ ] One clear primary action per screen (book / call / WhatsApp), visible without scrolling on 375px.
- [ ] Text contrast is readable everywhere, including text on images.
- [ ] Headings, spacing and alignment are consistent between sections.
- [ ] Nothing looks cramped on 375px or lost in empty space on 1440px.

## Per width
- [ ] 375px: nav works as a mobile menu, buttons are thumb-sized, no tiny text (< 14px body).
- [ ] 768px: layout isn't just a stretched phone or a squashed desktop.
- [ ] 1440px: content has a sensible max width; images aren't blurry or pixelated.

## Niche must-haves
- [ ] Everything listed under "Must-have on the site" in `niches/<niche>.md` is present.

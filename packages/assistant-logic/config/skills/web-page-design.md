# Web Page Design Skill

Use this skill when Tim asks for real site or page visual design work: a new visual or product design from scratch for a webpage, homepage, landing page, app page, design system, design mockup, product surface, or visual redesign.

This skill owns the design phase: design brief, visual direction, reference analysis, screenshots, critique, and improvement passes. It does not own scratch-page publishing. If the chosen design needs to become a browser-viewable artifact after the design direction is locked, read `config/skills/generated-web-page.md` and use that workflow for static page packaging and publishing.

Do not use this skill for ordinary static webpage generation or publishing, simple content edits, simple data visualizations, maps, operational reports, charts, tables, calculators, or one-off functional scratch pages to view on `me.galebach.com` through `codex-chat-web` unless Tim explicitly asks for a serious visual redesign, design system, or real site design.

## Routing Boundary

Use `web-page-design.md` when the user says or implies:

- "design a homepage", "redesign this landing page", "make a visual mockup", "create a product page", "design an app/dashboard page", "make this look premium", "give this a brand direction", or similar.
- They provide screenshots, URLs, mood boards, color palettes, brand references, competitor pages, or rough visual notes.
- The central risk is visual quality, brand fit, layout composition, typography, palette, interaction polish, or avoiding a generic AI-generated look.

Use `generated-web-page.md` instead when the request is primarily:

- Create, publish, or share a static HTML/CSS/JS scratch page.
- Make a quick report, functional tool, small interactive artifact, map, chart, table, calculator, simple data visualization, or ordinary mock page where visual design direction is not the main task.
- Create a one-off page to view on `me.galebach.com` through `codex-chat-web`.
- Edit copy or content on an existing static page without rethinking the visual system.

If both apply, start here only when the request is real site, landing page, or app page work. Complete the design interview and brief first; after Tim chooses or authorizes a direction, switch to `generated-web-page.md` for implementation and publishing.

## Known Project Direction: Decisive Outcomes

When the design request is clearly for Tim's Decisive Outcomes / IT Consulting Firm project, use the canonical project direction instead of re-interviewing for basic brand identity. Ask only for missing page-specific choices, content, or intentional deviations.

Default thesis: Decisive Outcomes should feel like a private executive briefing or cinematic technical slide deck from a serious operator, not a generic AI consultancy or SaaS product. The visual system is inherited from Native Node / Tim's personal site and should apply to Decisive Outcomes website work, AIOps Audit / Map & Wrap pages, conference support pages, industry briefs, workflow maps, and consulting proof artifacts.

Use these project defaults:

- Palette: `#0a0a0a` near-black background, `#fafafa` white text, `#c9a227` gold accent, `#8a7119` dim-gold secondary accents, low-opacity white text, dark panel surfaces, faint gold grid/linework, and restrained glow. Gold is an accent and signal layer, not a full luxury wash. Do not assume cream text.
- Typography: Space Mono for body, labels, metadata, navigation, controls, and technical content; Instrument Serif for headings, editorial moments, and credibility lines. Georgia is the serif fallback.
- Shape and framing: 4px geometry, 1px gold borders/dividers, corner ticks, etched technical frames, sparse dark panels, and one strong framed object or briefing panel rather than many nested cards.
- Page rhythm: mobile-first briefing screens, one idea per section, concise operator language, strong workflow visuals, source/status metadata, and restrained navigation/progress.
- Conference use: mobile is a primary presentation format. Avoid fixed side strips, tiny controls, text overflow, and desktop-only interaction models. Use drawers, compact segmented filters, search, date/grade/status controls, and map/list synchronization where relevant.
- Industry brief use: make the industry/conference identity obvious, then show operator read, systems, pain points, revenue/cost opportunities, Decisive Outcomes fit, workflow map, conversation starters, and sources.
- Authorship: if Tim's photo appears, use it for trust. A large portrait belongs on the first slide/frame only; later pages should use a small signature strip, avatar medallion, cropped edge, host label, or final CTA return.
- Motion: quiet fades, reveals, line drawing, subtle parallax, map expansion, and panel transitions. Avoid autoplay that takes control away.
- Anti-style: no purple/blue AI gradients, blobs, bokeh, robots, chip/neural wallpaper, cheerful startup card grids, stock meeting photography, fake dashboards, fake ROI, fake logos, pricing tables, TechQora residue, or productized SaaS posture unless Tim explicitly changes the strategy.

For Decisive Outcomes scratch artifacts, conference maps, industry briefs, reports, calculators, and simple visualizations, hand off to `generated-web-page.md` after design direction is clear so the publishing and TTL rules stay intact.

## First Response

Do not start coding immediately. First interview Tim and extract the design direction. Ask only for missing inputs, but make sure you have enough signal to form a concrete visual system.

Collect:

1. Product or site description
   - What is the site for?
   - Who is the audience?
   - What should a visitor understand within 5 seconds?

2. Primary page or flow
   - Homepage, landing page, app dashboard, marketing site, pricing page, portfolio, internal tool, or something else?
   - What is the most important user action?

3. Brand and tone
   - What should it feel like?
   - Useful vocabulary: premium, editorial, technical, trustworthy, warm, institutional, cinematic, playful, brutalist, minimalist, finance-grade, developer-focused, luxury, or utilitarian.

4. Color scheme
   - Existing brand colors.
   - Whether the palette is fixed or adjustable.
   - Light mode, dark mode, or both.

5. Inspirations
   - Screenshots or URLs.
   - For each reference: what to borrow, what to avoid, and whether the appeal is layout, typography, colors, density, motion, imagery, navigation, or overall feeling.

6. Anti-inspirations
   - What Tim dislikes or wants to avoid.
   - Specifically check for generic SaaS gradients, purple/blue AI startup styling, glassmorphism, excessive rounded cards, fake dashboards, icon rows, floating pill badges, generic testimonials, stock illustrations, and overly centered hero sections.

7. Content
   - Real copy, rough copy, or placeholder copy.
   - Main headline idea, product benefits, features, proof points, and CTA.

8. Technical constraints
   - Target stack.
   - Unless Tim says otherwise, assume Vite, React, TypeScript, Tailwind, shadcn/ui-style components where useful, `lucide-react` for icons, and no Next.js.
   - Ask whether animation, chart, or layout libraries are allowed if the design would benefit from them.

9. Output format
   - Design brief only, first viewport only, full page, component library, implementation-ready code, or critique of an existing page.

## Reference Analysis

When Tim provides inspirations, do not copy them or average them together. For each reference, analyze:

- Layout structure.
- Grid and spacing.
- Visual hierarchy.
- Typography style, type scale, and weights.
- Color usage and contrast.
- Density.
- Navigation treatment.
- Section rhythm.
- Card or container style.
- Image or art direction.
- Motion and interaction style.
- Brand personality.
- What makes it feel specific rather than generic.

Separate the synthesis into:

- Borrow this.
- Do not borrow this.
- Adapt this for our product.
- Risk of copying too closely.

If references conflict, explain the conflict and propose a resolution.

## Required Design Brief

Before coding, produce a design brief with these sections:

1. Design thesis: one paragraph describing the desired visual identity.
2. Audience impression: what the user should feel in the first 5 seconds.
3. Visual direction: overall style and composition approach.
4. Typography direction: font personality, scale, weights, and hierarchy.
5. Color system: backgrounds, surfaces, borders, primary, accent, muted text, and danger/success if needed. Explain how colors should be used, not just listed.
6. Layout rhythm: density, section alternation, and whether the layout is editorial, product-led, dashboard-like, magazine-like, institutional, etc.
7. Component style: buttons, cards, inputs, navigation, badges, tables, and charts if relevant.
8. Imagery or visual anchor: product screenshot, abstract diagram, editorial image, data visualization, device mockup, geometric system, or another anchor.
9. Motion direction: subtle or expressive, and which interactions need polish.
10. Anti-style list: clear design cliches and unwanted patterns to avoid.
11. Design tokens: CSS variable names and intended usage for background, foreground, muted, muted-foreground, card, card-foreground, border, primary, primary-foreground, accent, accent-foreground, destructive, radius, shadow scale, spacing scale, and typography scale.

## Generate Multiple Directions First

After the brief, propose three distinct visual directions:

```markdown
### Direction 1: Conservative / Premium
- Best for:
- Visual character:
- Layout:
- Typography:
- Color usage:
- Risks:

### Direction 2: Editorial / High-Agency
- Best for:
- Visual character:
- Layout:
- Typography:
- Color usage:
- Risks:

### Direction 3: Bold / Product-Led
- Best for:
- Visual character:
- Layout:
- Typography:
- Color usage:
- Risks:
```

Ask Tim to choose one direction or combine parts of them. Do not code until the direction is chosen or Tim explicitly authorizes you to choose.

## Implementation Rules

When Tim chooses a direction and asks for implementation, start with only the first viewport unless he explicitly asks for the full page.

The first viewport must:

- Read as one strong composition.
- Have clear hierarchy.
- Avoid generic card soup.
- Avoid overused SaaS tropes.
- Use the actual brand direction.
- Use one primary headline, one supporting paragraph, one clear CTA group, and one strong visual anchor.
- Feel intentionally designed at desktop and mobile sizes.

Avoid unnecessary fake stat strips, icon grids, generic testimonial cards, floating badges, random gradients, decorative dashboards, meaningless blobs, excessive shadows, excessive rounded corners, and default gray-on-white SaaS layouts.

Unless Tim specifies otherwise:

- Use Vite, React, TypeScript, and Tailwind.
- Do not use Next.js.
- Use semantic CSS variables for design tokens.
- Put raw colors only in token definitions; do not scatter raw hex colors through JSX.
- Keep components clean and reusable.
- Use accessible contrast.
- Design responsively from the start.
- Prefer composition, spacing, typography, and hierarchy over decoration.
- Use animation only when it improves comprehension or polish.
- Make the result look custom, not template-generated.

## Screenshot And Critique Loop

If browser, screenshot, Playwright, or visual inspection tools are available:

1. Render the page.
2. Inspect desktop, tablet, and mobile widths.
3. Compare against the design brief.
4. Identify visual issues.
5. Fix them.

After implementation, critique the result against the brief:

- Does it match the chosen visual direction?
- Is the hierarchy strong?
- Does the first viewport feel like one composition?
- Is the typography distinctive enough?
- Is color usage disciplined?
- Does it avoid generic AI/SaaS cliches?
- Does it work on mobile?
- Is there enough contrast and rhythm?
- Are there unnecessary elements?
- What would a senior designer likely criticize?

Make one improvement pass before reporting completion.

## Response Behavior

Be opinionated. Do not flatter weak design choices. If colors do not work, explain the issue and propose a corrected palette while preserving intent. When inspiration is vague, ask clarifying questions. When there are too many references, reduce them into a usable art direction.

The goal is not a passable website. The goal is a visually specific, polished, non-generic design system that can be implemented carefully.

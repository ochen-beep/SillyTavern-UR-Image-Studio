---
source: https://docs.bfl.ml — официальная документация Black Forest Labs (FLUX)
fetched: 2026-10-01
pages: guides/prompting_summary.md, guides/prompting_unified_basics.md, guides/prompting_unified_building.md, guides/prompting_unified_style.md, guides/prompting_unified_technical.md, guides/prompting_unified_reference.md, guides/prompting_editing_overview.md, guides/usecases_t2i_json_prompting.md
---

# FLUX — гайд по промптингу изображений (Black Forest Labs)

Собрано из восьми официальных страниц документации BFL. Применимо к моделям FLUX (FLUX.2, FLUX.1 [pro], FLUX.1 Kontext), которые доступны через OpenRouter, Pollinations и локальные workflow.


---

# Part 1: Обзор — как промптить FLUX

> source: https://docs.bfl.ml/guides/prompting_summary.md

# FLUX Prompting Guide

> Learn how to prompt FLUX — from the basics to advanced techniques.

Welcome to the official **FLUX** Prompting Guide. Whether you're just getting started or looking to refine your results, this guide walks you through everything you need to get the most out of FLUX — from crafting your first prompt to mastering advanced techniques.

<Frame>
  <img src="https://cdn.sanity.io/images/2gpum2i6/production/055402a70efb2876f1f70549374d7a37d71918f7-1504x1008.png" alt="A cinematic long shot with the camera positioned half underwater and half above the surface, showing a whale diving in the open ocean" />
</Frame>

This guide covers prompting for the entire FLUX model family — FLUX.1, FLUX.1 Kontext and FLUX.2. Where behavior differs meaningfully between models, we'll call it out explicitly.

If you're still choosing a model, see [Which Model to Choose?](/flux_2/flux2_overview#which-model-to-choose) in the FLUX.2 overview.

<CardGroup cols={2}>
  <Card title="Prompt Basics" icon="pen" href="/guides/prompting_unified_basics">
    How FLUX reads prompts — structure, word order, and what actually matters.
  </Card>

  <Card title="Editing Workflows" icon="pen-to-square" href="/guides/prompting_editing_overview">
    Single-reference and multi-reference editing with FLUX.2.
  </Card>

  <Card title="Video Generation" icon="film" href="/guides/prompting_video_overview">
    Prompt FLUX 3 for motion, camera behavior, clip continuation, and synchronized audio workflows.
  </Card>

  <Card title="Use Cases" icon="images" href="/guides/prompting_unified_usecases">
    Photorealism, typography, style transfer, and more — with example prompts.
  </Card>

  <Card title="Model Comparison" icon="table" href="/flux_2/flux2_overview#which-model-to-choose">
    Which FLUX.2 variant fits your workflow.
  </Card>
</CardGroup>


---

# Part 2: Основы промптинга

> source: https://docs.bfl.ml/guides/prompting_unified_basics.md

# Prompting Basics

> Core concepts and foundational knowledge for prompting FLUX models 

export const PromptCarousel = ({slides = [], height = "500px"}) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const items = slides.length > 0 ? slides : [{
    img: "https://images.unsplash.com/photo-1551963831-b3b1ca40c98e?w=800&fit=crop",
    prompt: "A cozy breakfast spread on a wooden table"
  }];
  const goTo = idx => {
    const next = Math.max(0, Math.min(items.length - 1, idx));
    setActiveIdx(next);
  };
  return <div className="not-prose" style={{
    borderRadius: "0.75rem",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "#000000",
    marginTop: 0
  }}>
      {}
      <div style={{
    position: "relative",
    width: "100%",
    height,
    overflow: "hidden"
  }}>
        <div style={{
    display: "flex",
    transition: "transform 400ms cubic-bezier(0.25, 1, 0.5, 1)",
    transform: `translateX(-${activeIdx * 100}%)`,
    height: "100%"
  }}>
          {items.map(item => <div key={item.img} style={{
    flex: "0 0 100%",
    height: "100%"
  }}>
              <img src={item.img} alt={item.prompt?.slice(0, 80) || ""} draggable={false} style={{
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    pointerEvents: "none"
  }} />
            </div>)}
        </div>

        {items.length > 1 && <>
            <button onClick={() => goTo(activeIdx - 1)} style={{
    position: "absolute",
    top: "50%",
    left: "12px",
    transform: "translateY(-50%)",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    opacity: activeIdx === 0 ? 0.3 : 1,
    transition: "opacity 200ms"
  }} disabled={activeIdx === 0}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button onClick={() => goTo(activeIdx + 1)} style={{
    position: "absolute",
    top: "50%",
    right: "12px",
    transform: "translateY(-50%)",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    opacity: activeIdx === items.length - 1 ? 0.3 : 1,
    transition: "opacity 200ms"
  }} disabled={activeIdx === items.length - 1}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2L10 7L5 12" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </>}
      </div>

      {}
      {items.length > 1 && items[0]?.title ? <div style={{
    display: "flex",
    justifyContent: "center",
    gap: "4px",
    padding: "12px 8px 4px",
    flexWrap: "wrap"
  }}>
          {items.map((item, idx) => <button key={idx} onClick={() => goTo(idx)} style={{
    padding: "4px 12px",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    fontSize: "0.7rem",
    fontWeight: activeIdx === idx ? 700 : 500,
    background: activeIdx === idx ? "rgba(255,255,255,0.15)" : "transparent",
    color: activeIdx === idx ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.45)",
    transition: "all 200ms ease"
  }}>
              {item.title}
            </button>)}
        </div> : items.length > 1 && <div style={{
    display: "flex",
    justifyContent: "center",
    gap: "8px",
    padding: "12px 0 4px"
  }}>
          {items.map((_, idx) => <button key={idx} onClick={() => goTo(idx)} style={{
    width: activeIdx === idx ? "24px" : "8px",
    height: "8px",
    borderRadius: "4px",
    border: "none",
    padding: 0,
    cursor: "pointer",
    background: activeIdx === idx ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)",
    transition: "all 300ms ease"
  }} />)}
        </div>}

      {}
      <div style={{
    padding: "0.5rem 0.5rem 0.6rem"
  }}>
        <div style={{
    padding: "0.6rem 0.75rem",
    borderRadius: "6px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    fontFamily: "monospace",
    fontSize: "0.75rem",
    lineHeight: 1.6,
    color: "rgba(255,255,255,0.7)",
    minHeight: "2.4rem",
    transition: "opacity 200ms ease"
  }}>
          <span style={{
    color: "rgba(255,255,255,0.35)",
    fontSize: "0.65rem",
    marginRight: "6px"
  }}>prompt:</span>
          {items[activeIdx]?.prompt || ""}
        </div>
      </div>
    </div>;
};

export const PromptDisplay = ({prompt}) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <div className="not-prose" style={{
    marginTop: "1rem"
  }}>
      <div style={{
    backgroundColor: "#1a1a1a",
    borderRadius: "1rem",
    padding: "1.25rem 1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem"
  }}>
        <p style={{
    color: "#e5e5e5",
    fontSize: "1rem",
    lineHeight: 1.6,
    margin: 0,
    fontFamily: "inherit"
  }}>
          {prompt}
        </p>
        <div style={{
    display: "flex",
    justifyContent: "flex-end"
  }}>
          <button onClick={copy} style={{
    backgroundColor: copied ? "#3d8a5b" : "var(--aspen-evergreen, #486A58)",
    color: "#fff",
    border: "none",
    borderRadius: "0.375rem",
    padding: "0.25rem 0.6rem",
    fontSize: "0.7rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 0.2s"
  }}>
            {copied ? "Copied!" : "Copy prompt"}
          </button>
        </div>
      </div>
    </div>;
};

export const CarouselThumbnails = ({images, height = "400px", thumbHeight = 60}) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const items = images || [{
    img: "https://images.unsplash.com/photo-1551963831-b3b1ca40c98e?w=800&fit=crop",
    title: "Breakfast"
  }, {
    img: "https://images.unsplash.com/photo-1551782450-a2132b4ba21d?w=800&fit=crop",
    title: "Burger"
  }, {
    img: "https://images.unsplash.com/photo-1522770179533-24471fcdba45?w=800&fit=crop",
    title: "Camera"
  }, {
    img: "https://images.unsplash.com/photo-1444418776041-9c7e33cc5a9c?w=800&fit=crop",
    title: "Coffee"
  }, {
    img: "https://images.unsplash.com/photo-1533827432537-70133748f5c8?w=800&fit=crop",
    title: "Hats"
  }, {
    img: "https://images.unsplash.com/photo-1558642452-9d2a7deb7f62?w=800&fit=crop",
    title: "Honey"
  }, {
    img: "https://images.unsplash.com/photo-1516802273409-68526ee1bdd6?w=800&fit=crop",
    title: "Basketball"
  }, {
    img: "https://images.unsplash.com/photo-1518756131217-31eb79b20e8f?w=800&fit=crop",
    title: "Fern"
  }];
  return <div className="not-prose" style={{
    width: "100%",
    borderRadius: "1rem",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "#0a0a0a",
    marginTop: 0
  }}>
      {}
      <div style={{
    position: "relative",
    width: "100%",
    height,
    overflow: "hidden"
  }}>
        <div style={{
    display: "flex",
    transition: "transform 400ms cubic-bezier(0.25, 1, 0.5, 1)",
    transform: `translateX(-${activeIdx * 100}%)`,
    height: "100%"
  }}>
          {items.map(item => <div key={item.img} style={{
    flex: "0 0 100%",
    height: "100%"
  }}>
              <img src={item.img} alt={item.title} draggable={false} style={{
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    pointerEvents: "none"
  }} />
            </div>)}
        </div>

        {}
        <div style={{
    position: "absolute",
    top: "12px",
    right: "12px",
    padding: "4px 10px",
    borderRadius: "6px",
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    fontSize: "0.75rem",
    fontWeight: 600,
    pointerEvents: "none",
    zIndex: 3
  }}>
          {activeIdx + 1} / {items.length}
        </div>
      </div>

      {}
      <div style={{
    display: "flex",
    gap: "4px",
    padding: "8px",
    overflowX: "auto",
    scrollbarWidth: "none"
  }}>
        {items.map((item, idx) => <button key={item.img} onClick={() => setActiveIdx(idx)} style={{
    flexShrink: 0,
    width: `${thumbHeight * 1.5}px`,
    height: `${thumbHeight}px`,
    borderRadius: "6px",
    overflow: "hidden",
    border: activeIdx === idx ? "2px solid rgba(255,255,255,0.8)" : "2px solid transparent",
    opacity: activeIdx === idx ? 1 : 0.5,
    transition: "all 250ms ease",
    cursor: "pointer",
    padding: 0,
    background: "none"
  }}>
            <img src={`${item.img}?w=180&h=120&fit=crop&auto=format`} alt={item.title} draggable={false} style={{
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    pointerEvents: "none"
  }} />
          </button>)}
      </div>

      {}
      <div style={{
    padding: "0.5rem 0.5rem 0.6rem"
  }}>
        <div style={{
    padding: "0.6rem 0.75rem",
    borderRadius: "6px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    fontFamily: "monospace",
    fontSize: "0.75rem",
    lineHeight: 1.6,
    color: "rgba(255,255,255,0.7)",
    minHeight: "2.4rem",
    transition: "opacity 200ms ease"
  }}>
          <span style={{
    color: "rgba(255,255,255,0.35)",
    fontSize: "0.65rem",
    marginRight: "6px"
  }}>prompt:</span>
          {items[activeIdx]?.title || ""}
        </div>
      </div>
    </div>;
};

export const PromptFormulaFrame = () => {
  return <div className="prompt-formula-card not-prose">
      <div className="prompt-formula-card__border">
        <div className="prompt-formula-card__surface">
          <div className="prompt-formula-card__wash" aria-hidden="true" />
          <pre className="prompt-formula-card__copy">
            {`[SUBJECT], [LOCATION],
[STYLE], [CAMERA SETTINGS], [LIGHTING], [COLORS], [EFFECT],
[ADDITIONAL ELEMENTS]`}
          </pre>
        </div>
      </div>
    </div>;
};

### What is Prompting?

Prompting in text-to-image generation refers to the process of entering a text description — the prompt — that FLUX uses to generate a matching image. Your prompt is the primary way you communicate intent: what should be in the image, how it should look, and what mood or style it should convey.

<div className="prompt-image-stack">
  <img className="prompt-image-stack__image" src="https://cdn.sanity.io/images/2gpum2i6/production/7b51ac4d05b7cb52ed7f64493596245075be35c4-1840x1088.png" alt="Chromatic 3D cursor on a black background" />

  <PromptDisplay prompt="a chromatic 3D rendition of a cursor, black background" />
</div>

## What Can a Prompt Look Like?

A prompt passed to FLUX can take many forms. There is no single correct format — what matters is that your description gives FLUX enough to work with.

<PromptFormulaFrame />

<Tip>
  This template is a useful starting structure, not a strict formula. You can keep it concise, expand individual slots, or ignore parts that are not relevant to your image.
</Tip>

## Use Natural Language

FLUX works best when your prompt reads like a clear description of the image you want to generate. Natural language helps the model understand what should appear in the image, how the elements relate to each other, and what visual direction to follow. The clearer the description, the easier it is for FLUX to produce a focused and consistent result.

<PromptCarousel
  height="500px"
  slides={[
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/81ed3f645a76a4af25ceb1e927849d2226f6992d-1504x1008.png",
  prompt: "At high noon on a blustery day, capture the surreal presence of a sentient tree, seemingly rooted underwater just off a tumultuous ocean shore. Employ a sweeping panning shot, bathing the scene in cinematic natural light and a stark palette of winter whites and greys, as if glimpsing a spectral sentinel through a watery veil."
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/055402a70efb2876f1f70549374d7a37d71918f7-1504x1008.png",
  prompt: "A professional cinematic long shot with the camera positioned half underwater and half above the surface in the open ocean. Beneath the water, a large northern whale is diving smoothly, its tail rising above the surface while the rest of its body descends into the deep blue. The ocean is calm and clear, with bubbles drifting upward from the whale and soft sun rays piercing through the water."
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/c028ca9c6ba957278d0ecb695636b6bba26f7eb3-1504x1008.png",
  prompt: "A wide, sweeping 35mm Kodak film aerial photograph, underexposed and richly grainy, capturing the iconic Victoria Harbour of Hong Kong at dusk. The sky is a blend of soft, desaturated oranges, purples, and deep twilight blues. The water of the harbour reflects the fading light and the emerging city glow."
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/2a6bb30c8acc4a2adfa7673517c5d07e7beb6949-1504x1008.png",
  prompt: "Realistic moody nature photograph of a white swan gliding calmly on still dark water, captured in soft natural light. The swan’s reflection is clearly visible on the surface. The scene is framed by out-of-focus foliage in the foreground, creating a natural vignette and a sense of depth. Warm golden tones from late-day sunlight."
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/120680795c38b561880fbc5e265d5d7b6040f22c-1504x1008.png",
  prompt: "A penguin wearing a tiny tuxedo to a penguin wedding"
},
]}
/>

## Text in images

When you want FLUX to generate specific text inside an image, place the exact wording in quotation marks. This makes it clearer that the text should appear visibly in the final image, rather than being treated as part of the general prompt description. Quotation marks help separate written content from the rest of the scene, which gives FLUX a stronger signal to render the words as text.

<PromptCarousel
  height="500px"
  slides={[
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/b3300d8897ec5682f886be1c9576c7a7084d775e-1504x1008.png",
  prompt: "A photorealistic still life of matchsticks arranged on a beige paper background. On the left, a group of burnt-out matchsticks leaning together with charred black tips and rising smoke. In the center, a single unlit match standing upright, separating the two groups. On the right, a neat row of fresh red-tipped matches. Below the scene, bold serif typography reads \"The Importance Of Being Non-Aligned\". Warm, soft studio lighting with subtle shadows."
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/e55dd7892b9ef7e9a3ee0f46ac6cf77b1d508fa8-1504x1008.png",
  prompt: "An anime-style illustration of a cute snake being poked on the head by a human finger. The snake has big blue eyes and a gentle smile. A white speech bubble reads \"Wow, what are you doing here?! I am sleeping\". Sandy desert background with warm tones. Soft cel-shading, expressive cartoon style."
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/b7f4b87f8eb8d23633fe09fdc6ca83ed71d4acdf-1504x1008.png",
  prompt: "A humorous infographic-style meme image with the bold headline \"WHY DOES THIS CHAT KEEP GETTING RESET\" at the top. The scene shows a person at a desk squeezed between two large server towers labeled \"MEMORY LIMIT\" and \"TOKEN BUDGET\". In the center, a red warning triangle reads \"DELETION ZONE\" with fire and emojis. A green banner says \"YOUR BEAUTIFUL IMAGES\" and a \"404 IMAGES LOST\" error badge appears on the right. Three info boxes at the bottom with satirical descriptions. Clean digital illustration style with blue and teal tones."
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/8771cfc4a0d0cd5257a452926c1d722c36e8b411-1504x1008.png",
  prompt: "A set of five car air freshener stickers on a gray background, each shaped differently and spelling out \"FLUX 2\". A blue star-burst shape with \"F\" and \"Fast\", a red droplet with a rainbow \"L\" and \"Lightweight\", a holographic rounded square with green \"U\" and \"Upscaled\", a green Christmas tree shape with \"X\" and \"Xtra\", and a round red prohibition sign with a banana and the number \"2\". Glossy sticker aesthetic with subtle shadows."
},
]}
/>

## Refine As You Go

Strong prompts usually come from iteration, not from trying to write the perfect prompt on the first attempt.

A practical loop is:

1. Start with a simple version
2. Check what FLUX got right and wrong
3. Adjust one important detail at a time

If the image is close but not there yet, tweak the subject, framing, lighting, or style before rewriting everything.

<CarouselThumbnails
  height="400px"
  thumbHeight={60}
  images={[
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/212505bd3782a164c4aabb82241b4de891376715-2048x1376.png",
  title: "A tall sharp-featured man in an oversized charcoal wool coat"
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/08b62970a32a753eec0e3d4a421eb880715ed9fb-2048x1376.png",
  title: "A tall sharp-featured man in an oversized charcoal wool coat, standing on a wet cobblestone street at night"
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/d213308ada76d6e6917e890c9f441869ea8eb383-2048x1376.png",
  title: "A tall sharp-featured man in an oversized charcoal wool coat, standing on a wet cobblestone street at night, fashion editorial, moody street lighting, oversized charcoal wool Maison Margiela coat, he holds a teddybear in his hands"
},
{
  img: "https://cdn.sanity.io/images/2gpum2i6/production/0960834da97c20ab384f221b8f823e2892cf0ff6-2048x1376.png",
  title: "A tall sharp-featured man in an oversized charcoal wool coat, standing on a wet cobblestone street at night, fashion editorial, moody street lighting, oversized charcoal wool Maison Margiela coat, he holds

---

# Part 3: Как построить хороший промпт

> source: https://docs.bfl.ml/guides/prompting_unified_building.md

# Building a Good Prompt

> How FLUX reads prompts and how to structure them into clear, controllable image instructions

export const PromptDisplay = ({prompt}) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <div className="not-prose" style={{
    marginTop: "1rem"
  }}>
      <div style={{
    backgroundColor: "#1a1a1a",
    borderRadius: "1rem",
    padding: "1.25rem 1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem"
  }}>
        <p style={{
    color: "#e5e5e5",
    fontSize: "1rem",
    lineHeight: 1.6,
    margin: 0,
    fontFamily: "inherit"
  }}>
          {prompt}
        </p>
        <div style={{
    display: "flex",
    justifyContent: "flex-end"
  }}>
          <button onClick={copy} style={{
    backgroundColor: copied ? "#3d8a5b" : "var(--aspen-evergreen, #486A58)",
    color: "#fff",
    border: "none",
    borderRadius: "0.375rem",
    padding: "0.25rem 0.6rem",
    fontSize: "0.7rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 0.2s"
  }}>
            {copied ? "Copied!" : "Copy prompt"}
          </button>
        </div>
      </div>
    </div>;
};

export const PromptFormulaFrame = () => {
  return <div className="prompt-formula-card not-prose">
      <div className="prompt-formula-card__border">
        <div className="prompt-formula-card__surface">
          <div className="prompt-formula-card__wash" aria-hidden="true" />
          <pre className="prompt-formula-card__copy">
            {`[SUBJECT], [LOCATION],
[STYLE], [CAMERA SETTINGS], [LIGHTING], [COLORS], [EFFECT],
[ADDITIONAL ELEMENTS]`}
          </pre>
        </div>
      </div>
    </div>;
};

## Prompt length

<Tip>
  FLUX.2 supports prompts up to 32K tokens.
</Tip>

| Length | Words | Best For |
| - | - | - |
| **Short** | 10-30 | Quick concepts, fast iteration, style exploration |
| **Medium** | 30-80 | Most scenes and everyday prompting |
| **Long** | 80-300+ | Complex multi-subject scenes or very directed outputs |

<Warning>
  Start short. Add only what changes the image. More words do not automatically mean better results.
</Warning>

## Structure helps

The goal is not to write the longest possible prompt. The goal is to give FLUX a clear structure.

A good prompt works like a set of instructions. It tells the model what kind of image you want, what the main subject is, where the scene happens, and how it should feel visually.

One useful way to organize that information is this template:

<PromptFormulaFrame />

<Tip>
  This is a prompt-building aid, not a rule. You do not need every slot every time. Use the parts that actually improve the image you want.
</Tip>

Here are a few visual examples of that structure applied in practice:

<img src="https://cdn.sanity.io/images/2gpum2i6/production/da44ecfd2b1d35befadf9f3bc375dc9198365689-1888x1056.png" alt="Prompt structure example showing a photorealistic portrait" className="mx-auto" style={{ width: "79%" }} />

<img src="https://cdn.sanity.io/images/2gpum2i6/production/5dc2e9059334a6c6c6cfa64bcf22afad13648681-1440x398.png" alt="Prompt structure breakdown with labeled prompt components" className="mx-auto" style={{ width: "92%" }} />

## Start by describing the image

Start with the core subject or content of the image.

That can be something simple:

* `a cat`
* `a family on a beach`
* `autumn foliage in a park`

Then add the details that make the image more specific and visually interesting.

Useful details include:

* **What the subject is doing**: `looking up`, `playing`, `running`
* **How the action feels**: `joyfully`, `fearfully`, `boldly`
* **The mood of the image**: `ominous morning rain`, `dangerous sunset mountains`, `nostalgic coffee table`

The more relevant detail you provide, the more likely you are to get a compelling result. But each model interprets prompts differently, so the same wording will not behave identically everywhere.

For FLUX, the most reliable pattern is usually:

1. Start with a clear subject
2. Add the main action or state
3. Add mood, context, and visual direction only when they improve the image

<Warning>
  Specific detail helps. Filler hurts.
</Warning>

The difference between a simple prompt and a directed prompt is often easy to see:

<Columns cols={2}>
  <div>
    <img src="https://cdn.sanity.io/images/2gpum2i6/production/ba997b2d9c1715f13763cfe585864db1a8b4bcbe-1888x1056.png" alt="Basic prompt: dog in park" />

    <PromptDisplay prompt="A dog sitting in a sunny park" />
  </div>

  <div>
    <img src="https://cdn.sanity.io/images/2gpum2i6/production/7412a29a1a5c8f3fb7668c161bca0572f5682a71-1888x1056.png" alt="Detailed prompt: golden retriever jumping in living room" />

    <PromptDisplay prompt="A golden retriever mid-leap chasing a tennis ball across a sunlit hardwood floor in a cozy living room, muddy paw prints trailing behind, warm afternoon light streaming through sheer curtains, shallow depth of field, candid pet photography, 35mm lens" />
  </div>
</Columns>

## The prompt components

| Component | What it controls | Example |
| - | - | - |
| **Image type** | The overall category or framing of the image | `portrait`, `landscape`, `macro` |
| **Subject** | The main thing you want to see | `a young woman with curly red hair` |
| **Location** | The setting or environment | `in a futuristic space station` |
| **Style** | The artistic or visual direction | `editorial photography`, `anime illustration` |
| **Camera settings** | Lens, framing, depth of field, shot style | `85mm lens, shallow depth of field` |
| **Lighting** | How the image is lit | `soft window light`, `golden hour sunlight` |
| **Colors** | The dominant palette | `muted earth tones`, `deep green and cream` |
| **Effect** | Extra visual treatment | `motion blur`, `film grain`, `soft bloom` |
| **Additional elements** | Supporting details that enrich the scene | `wind-blown fabric, falling leaves` |

## Image type

The **image type** gives FLUX a broad idea of what kind of image to create.

Even before you describe the subject, it affects composition and visual expectations.

Useful starting points:

* **Portrait**: close-up or medium shot focused on a person or character
* **Landscape**: wide scene showing nature, architecture, or an environment
* **Bird's-eye view**: top-down perspective, as if seen from high above
* **Macro**: extreme close-up showing fine details
* **Abstract**: shape, color, or texture-driven composition

If you are learning how prompt parts change the result, start with a simple image type such as `portrait`. It makes the effect of later additions easier to see.

## Subject

The **subject** is the main focus of the image.

Be specific when it matters. Clear subjects are easier for FLUX to render consistently than vague ones.

Examples:

* `a young woman with curly red hair`
* `an elderly man with a long white beard`
* `a cyberpunk teenager with neon blue hair`
* `a Siamese cat with a blue collar`
* `a single red rose`

## Location

The **location** sets the scene. It provides context and changes the mood of the image even when the subject stays the same.

Examples:

* `in a bustling city street`
* `on a serene beach at sunset`
* `in a futuristic space station`
* `inside a dimly lit jazz club`
* `in a dense forest after rain`

Changing only the location is one of the fastest ways to explore variations on the same concept.

## Style

The **style** tells FLUX what visual language to use. This can be photographic, illustrative, cinematic, painterly, or highly specific to a medium.

Examples:

* `fashion editorial photography`
* `wildlife documentary style`
* `anime illustration`
* `oil painting`
* `minimalist product photography`

If style is central to the result, mention it early and keep it concrete.

### Art form and style

If you want a specific visual effect, describe both the **art form** and the **style**.

#### Photography

Photography is useful when you want realistic images.

You can control:

* framing
* lighting conditions
* lens feel
* camera distance
* depth of field

Example:

`A child playing on a sunny beach, building a sandcastle, action photography, high shutter speed, soft warm light`

#### Painting

Painting prompts work well when you want texture, brushwork, and stronger artistic interpretation.

You can combine:

* techniques such as `oil painting` or `watercolor`
* movements such as `impressionism` or `fauvism`
* artist references when appropriate

Example:

`Impressionist oil painting of a small robot in a garden`

#### Illustration

Illustration is useful when you want a drawn or stylized result rather than a photo-like one.

Examples of illustration directions:

* `pencil drawing`
* `charcoal sketch`
* `cartoon illustration`
* `poster illustration`

Example:

`Illustration of dinosaurs drawn in a childlike style, cute and playful`

#### Digital art

Digital art is useful when you want a more synthetic, graphic, or contemporary visual language.

Example:

`An isolated convenience store in the desert at sunset, lo-fi digital art, nostalgic atmosphere`

#### Film still

Film still is useful when you want something cinematic and emotionally charged.

Example:

`Buildings on fire, old film still, smoky atmosphere, dramatic contrast`

#### Other art forms

You can also experiment with:

* `sculpture`
* `collage`
* `street art`
* `textile art`
* `installation art`
* `ceramic art`
* `lithography`

Mixing art forms and styles can lead to strong results, but keep the combination coherent.

## Camera settings

The **camera settings** define how the image is framed or captured. This is most useful when you want a photographic result.

Examples:

* `85mm lens`
* `wide-angle shot`
* `close-up framing`
* `shallow depth of field`
* `shot from a low angle`

Use these when framing matters. If the exact camera look is not important, you can skip this part.

### Framing

Framing controls how the subject is positioned in the image.

Prompt order matters here too. If FLUX keeps pulling too far back, make the subject clear first and move environmental details later in the sentence.

This version can lead to a wider scene than intended:

`Person standing inside a forest fire, strong determined attitude, close-up shot, realistic`

This rewrite usually gives you more control:

`Person with a strong determined expression, forest fire in the background, close-up shot, realistic`

Useful framing language:

* `close-up`
* `medium shot`
* `wide shot`
* `overhead view`
* `point-of-view shot`
* `dutch angle`
* `low-angle shot`

## Lighting

Lighting shapes contrast, mood, depth, and realism.

Examples:

* `soft window light`
* `golden hour sunlight`
* `harsh direct flash`
* `overcast daylight`
* `neon backlighting`

You can also use:

* `soft light`
* `hard light`
* `dramatic lighting`
* `morning light`
* `sunset light`
* `golden hour`

## Colors

Colors define the palette and help FLUX keep the image visually coherent.

Examples:

* `muted beige and forest green tones`
* `deep blue and silver`
* `warm orange and pink sunset colors`
* `monochrome black and white`
* `desaturated pastel palette`

### Color scheme

Color scheme is especially useful when you want the entire image to feel unified.

Example:

`A futuristic busy city, purple and green color scheme`

Lighting already influences color, but explicit palette direction helps FLUX stay more consistent.

## Effect

Effect adds visual treatment on top of the base scene.

Examples:

* `film grain`
* `soft bloom`
* `motion blur`
* `bokeh`
* `double exposure effect`

Use one or two strong effects. Too many can make the image feel unfocused.

## Additional elements

Additional elements are the supporting details that make an image feel complete.

Examples:

* `floating dust particles`
* `wind-blown fabric`
* `falling leaves`
* `glowing reflections on wet pavement`
* `scattered flowers on the table`

## Detail and realism

You can also add detail or realism cues when you want the image to feel sharper, more polished, or more believable.

Examples:

* `highly detailed`
* `realistic`
* `ultrarealistic`
* `cinematic detail`
* `sharp texture detail`

Avoid stacking too many generic quality terms. One or two strong realism cues are usually enough.

## Build one prompt step by step

Here is the same idea expanded gradually:

<Steps>
  <Step title="Start with image type and subject">
    `portrait, a young woman with curly red hair`

    <Frame>
      <img src="https://cdn.sanity.io/images/2gpum2i6/production/67916708f9446feb1b2490f2ae48d705e0885c5d-1888x1056.png" alt="Portrait of a young woman with curly red hair" />
    </Frame>
  </Step>

  <Step title="Add the location">
    `portrait, a young woman with curly red hair, in a bustling city street`

    <Frame>
      <img src="https://cdn.sanity.io/images/2gpum2i6/production/041858a6dd7d6f4db59efc8d7d77aaf50e0e5d2f-1888x1056.png" alt="Young woman with curly red hair in a city street" />
    </Frame>
  </Step>

  <Step title="Add the visual direction">
    `portrait, a young woman with curly red hair, in a bustling city street, fashion editorial photography, 85mm lens, soft golden hour light`

    <Frame>
      <img src="https://cdn.sanity.io/images/2gpum2i6/production/ddcfe6482dd2aad1a1ea8a3f6826d98bff0098eb-1888x1056.png" alt="Fashion editorial portrait with golden hour light" />
    </Frame>
  </Step>

  <Step title="Refine with color and detail">
    `portrait, a young woman with curly red hair, in a bustling city street, fashion editorial photography, 85mm lens, soft golden hour light, warm amber and charcoal tones, subtle film grain, wind-blown hair and blurred city lights`

    <Frame>
      <img src="https://cdn.sanity.io/images/2gpum2i6/production/2003aeb58867b0d2e7bc9bd5c5dc90bd9081b113-1888x1056.png" alt="Final portrait with warm tones, film grain, and wind-blown hair" />
    </Frame>
  </Step>
</Steps>

## Practical advice

* Start with the image type and subject.
* Add style and lighting next if the first result feels generic.
* Use colors when you want stronger visual cohesion.
* Add effect and additional elements last. These are refinements, not the foundation.
* If a prompt gets bloated, remove the parts that do not clearly change the image.

<Warning>
  Do not treat the template like a checklist you must always fill out. Strong prompts are specific, not necessarily long.
</Warning>


---

# Part 4: Стиль, эстетика и текст в изображениях

> source: https://docs.bfl.ml/guides/prompting_unified_style.md

# Style, Aesthetics & Text

> Style keywords, photorealistic looks, illustration styles, and how to get readable text in images

export const PromptDisplay = ({prompt}) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <div className="not-prose" style={{
    marginTop: "1rem"
  }}>
      <div style={{
    backgroundColor: "#1a1a1a",
    borderRadius: "1rem",
    padding: "1.25rem 1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem"
  }}>
        <p style={{
    color: "#e5e5e5",
    fontSize: "1rem",
    lineHeight: 1.6,
    margin: 0,
    fontFamily: "inherit"
  }}>
          {prompt}
        </p>
        <div style={{
    display: "flex",
    justifyContent: "flex-end"
  }}>
          <button onClick={copy} style={{
    backgroundColor: copied ? "#3d8a5b" : "var(--aspen-evergreen, #486A58)",
    color: "#fff",
    border: "none",
    borderRadius: "0.375rem",
    padding: "0.25rem 0.6rem",
    fontSize: "0.7rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 0.2s"
  }}>
            {copied ? "Copied!" : "Copy prompt"}
          </button>
        </div>
      </div>
    </div>;
};

## Photorealistic Styles

FLUX generates photorealistic images from natural language. Reference specific eras, cameras, and film stocks for distinctive looks.

| Style | Key Descriptors |
| - | - |
| **Modern Digital** | "shot on Sony A7IV, clean sharp, high dynamic range" |
| **2000s Digicam** | "early digital camera, slight noise, flash photography, candid, 2000s digicam style" |
| **80s Vintage** | "film grain, warm color cast, soft focus, 80s vintage photo" |
| **Analog Film** | "shot on Kodak Portra 400, natural grain, organic colors" |

<Tabs>
  <Tab title="Modern Photorealism">
    <Frame>
      ![Tiger cub under banana leaf in rainy jungle](https://cdn.sanity.io/images/2gpum2i6/production/bc6432890df19f127624df9eb47c7d5fdd984a3d-2656x1504.png)
    </Frame>

    <PromptDisplay prompt="Soaking wet tiger cub taking shelter under a banana leaf in the rainy jungle, close up photo" />
  </Tab>

  <Tab title="2000s Digicam">
    <Frame>
      ![Sloth in Bangkok nightlife, digicam style](https://cdn.sanity.io/images/2gpum2i6/production/d02f27fc01e66dca0f812c02678e3502cf664d19-1328x752.png)
    </Frame>

    <PromptDisplay prompt="Sloth out drinking in Bangkok at night in a street full of party folks, 2000s digicam style, people in the background fading" />
  </Tab>

  <Tab title="80s Vintage">
    <Frame>
      ![Baby penguins in trampoline park, 80s vintage](https://cdn.sanity.io/images/2gpum2i6/production/ef2490df716e6b6eeaf7d7bc4e9af0200fa53b52-1328x752.png)
    </Frame>

    <PromptDisplay prompt="A group of baby penguins in a trampoline park, having the time of their lives, 80s vintage photo" />
  </Tab>

  <Tab title="Analog Photography">
    <Frame>
      ![Old faded family portrait](https://cdn.sanity.io/images/2gpum2i6/production/dc7ce17bfc1ec5d526ae33bc975d00459590f9de-1328x752.png)
    </Frame>

    <PromptDisplay prompt="An old faded family portrait photograph from the early 2000s showing a family of five standing stiffly in front of their modest wooden farmhouse" />
  </Tab>
</Tabs>

<Tip>For photorealism, specify camera models, lenses, and film stocks. "Shot on Fujifilm X-T5, 35mm f/1.4" produces more authentic results than just "professional photo."</Tip>

### Camera and Lens Simulation

Be specific about camera settings for authentic results:

```
Shot on Hasselblad X2D, 80mm lens, f/2.8, natural lighting
```

```
Canon 5D Mark IV, 24-70mm at 35mm, golden hour, shallow depth of field
```

## Art Styles & Illustration

FLUX handles a wide range of artistic styles beyond photorealism. Name the style specifically and describe its visual characteristics.

**Style fusion** — Combine two styles with a unifying palette:

<Card title="Style Fusion Example" horizontal img="https://cdn.sanity.io/images/gsvmb6gz/production/f11c404eed10d12b215b7a07e601bf41e7fcc4bb-1392x752.jpg">
  *"Ancient Greek marble statue precision and anatomical detail, infused with cyberpunk neon lighting, holographic overlays, and electric blue/magenta glow effects, set against dark futuristic environments"*
</Card>

**Style + mood annotations** — Add explicit tags at the end of your prompt for consistent aesthetics:

```
[Scene description]. Style: Country chic meets luxury lifestyle editorial.
Mood: Serene, romantic, grounded.
```

```
[Scene description]. Shot on 35mm film (Kodak Portra 400) with shallow
depth of field — subject razor-sharp, background softly blurred.
```

<Columns cols={3}>
  <Frame caption="1990s fashion editorial">
    <img src="https://cdn.sanity.io/images/2gpum2i6/production/ad3f43a52bdf1b82350e58da90d50d0122b8dc14-1440x2048.jpg" alt="1990s editorial" />
  </Frame>

  <Frame caption="Surreal interior">
    <img src="https://cdn.sanity.io/images/2gpum2i6/production/dd1aa1741cc7a7e8149672f0aa65fc326561bbc6-1440x2048.jpg" alt="Surreal interior" />
  </Frame>

  <Frame caption="Golden hour silhouette">
    <img src="https://cdn.sanity.io/images/2gpum2i6/production/a182f770a402a3b318336d6156b5eb1dd8c80cec-1440x2048.jpg" alt="Golden hour silhouette" />
  </Frame>
</Columns>

## Lighting

Lighting has the **greatest single impact** on output quality. Describe it like a photographer would — "good lighting" is not enough.

**What to describe:**

* **Source**: natural, artificial, ambient
* **Quality**: soft, harsh, diffused, direct
* **Direction**: side, back, overhead, fill
* **Temperature**: warm, cool, golden, blue
* **Interaction**: catches, filters, reflects on surfaces

<AccordionGroup>
  <Accordion title="Portrait Lighting">
    **Rembrandt lighting** (45° key light) — triangle of light on the face for dramatic portraits:

    *"Portrait with Rembrandt lighting, key light at 45 degrees, dramatic chiaroscuro effect"*

    **Split lighting** (90° side light) — half-face illuminated for high contrast:

    *"Artistic portrait, split lighting, strong side illumination, dramatic contrast"*

    <Columns cols={2}>
      <Frame caption="Rembrandt lighting">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/ae53f6422efdaf3f51e1e0bd928d7c3952e8a7de-1392x752.jpg" alt="Rembrandt lighting" />
      </Frame>

      <Frame caption="Split lighting">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/284c21b1028f62e395461f7e7e3142f2c7823386-1392x752.png" alt="Split lighting" />
      </Frame>
    </Columns>
  </Accordion>

  <Accordion title="Environmental Light Quality">
    **Window light** = soft, even illumination

    **Golden hour** = warm and soft

    **Blue hour** = cool and moody

    **Overhead artificial** = harsh and dramatic

    <Columns cols={2}>
      <Frame caption="Window Light">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/d95a5129f006cd34e184451a5e813be3f3237409-1392x752.jpg" alt="Window light" />
      </Frame>

      <Frame caption="Golden hour">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/b9635dc280dfaaba1684083b0f8bbb145eeb3ebf-1392x752.jpg" alt="Golden hour" />
      </Frame>

      <Frame caption="Blue hour">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/6fcccf61808d5cb23b8339a52ade9cd7adf435e3-1392x752.jpg" alt="Blue hour" />
      </Frame>

      <Frame caption="Overhead artificial light">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/9487dd7f4c2ac8a16f5a4ce130ffa010fa57f7f2-1392x752.jpg" alt="Overhead artificial light" />
      </Frame>
    </Columns>
  </Accordion>

  <Accordion title="Cinematic Lighting">
    **Chiaroscuro** — high contrast light/shadow for drama:

    *"Film noir detective scene, single practical desk lamp, strong chiaroscuro lighting"*

    **Practical lighting** — visible light sources in scene for realism:

    *"Cyberpunk street scene, neon signs and LED strips providing atmospheric lighting"*

    <Columns cols={2}>
      <Frame caption="Chiaroscuro">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/4ac0d069fa68429339f919d528e7c88e403184d6-1392x752.jpg" alt="Chiaroscuro" />
      </Frame>

      <Frame caption="Practical lighting">
        <img src="https://cdn.sanity.io/images/gsvmb6gz/production/ae31cf4f6cd3d434bddbf7d5659be68fd03c3d91-1392x752.jpg" alt="Practical lighting" />
      </Frame>
    </Columns>
  </Accordion>
</AccordionGroup>

## Text in Images

FLUX handles text well when prompted correctly. Use this three-step approach:

<Steps>
  <Step title="Enclose in Quotation Marks">
    Use quotes for exact text: `"COFFEE SHOP"` or `"Est. 1952"`
  </Step>

  <Step title="Describe Placement">
    Specify where text appears: *"The text 'OPEN' appears in red neon letters above the door"*
  </Step>

  <Step title="Specify Font Style">
    Name the style: *"elegant serif typography"* or *"bold industrial sans-serif lettering"*
  </Step>
</Steps>

<Tabs>
  <Tab title="Neon Sign">
    !['Open' neon sign](https://cdn.sanity.io/images/2gpum2i6/production/324a5024e679ee8a693821fc5bbdedb2c3fde129-1888x1056.png)

    <PromptDisplay prompt="A Entry of a Sushi Restaurant, The text 'OPEN' appears in red neon letters above the door" />
  </Tab>

  <Tab title="Product Advertisement">
    <Frame>
      <img src="https://cdn.sanity.io/images/2gpum2i6/production/7730d0482ee19d0d3207b5cbbb55074c3b66d554-1456x1920.png" alt="Phone advertisement" style={{ maxWidth:"420px",margin:"0 auto",display:"block" }} />
    </Frame>

    <PromptDisplay prompt="Samsung Galaxy S25 Ultra product advertisement, 'Ultra-strong titanium' headline, 'Shielded in a strong titanium frame, your Galaxy S25 Ultra always stays protected' subtext, close-up of phone edge showing titanium frame, dark gradient background, clean minimalist tech aesthetic, professional product photography" />
  </Tab>

  <Tab title="Retro Poster">
    <Frame>
      <img src="https://cdn.sanity.io/images/2gpum2i6/production/6d99bf4508c927ab16b67359b6ff70cdc992b279-1456x1920.png" alt="Groovy retro poster" style={{ maxWidth:"420px",margin:"0 auto",display:"block" }} />
    </Frame>

    <PromptDisplay prompt={'Groovy retro poster with the quote "If you love me let me sleep". Bold 70s typography in deep red and warm pink tones. Cream background and bold orange doodle around the text. Funky layout with playful shadow. Style: bold vintage aesthetic, dopamine decor'} />
  </Tab>

  <Tab title="Magazine Cover">
    <Frame>
      <img src="https://cdn.sanity.io/images/2gpum2i6/production/00ddd4ce8b582891f3b174462dc635dac4e45d46-1456x1920.jpg" alt="Magazine cover" style={{ maxWidth:"420px",margin:"0 auto",display:"block" }} />
    </Frame>

    <PromptDisplay prompt="Women's Health magazine cover, April 2025 issue, 'Spring forward' headline, woman in green outfit sitting on orange blocks, white sneakers, 'Covid: five years on' feature text, '15 skincare habits' callout, professional editorial photography, magazine layout with multiple text elements" />
  </Tab>
</Tabs>

### Text Rendering Tips

* **Front-load text descriptions** for better accuracy
* **Use quotation marks** around exact text you want rendered
* **Describe color and effects**: "red neon letters", "gold serif lettering", "chalk on blackboard"
* **Use hex codes** for brand-precise colors: *"The logo text 'ACME' in color #FF5733"*
* **Keep text short** — long strings are harder to render accurately
* **Specify font character**: serif = traditional/formal, sans-serif = modern, script = elegant, display = bold/impactful

### Typography Styles Reference

| Style | Effect | Example |
| - | - | - |
| **3D text** | Dimensional, impactful | "raised chrome letters with realistic metal reflections" |
| **Neon effects** | Atmospheric, glowing | "glowing neon text with electric blue light" |
| **Vintage signs** | Authentic, weathered | "weathered painted text with chipped paint and rust" |
| **Environmental** | Integrated into scene | "carved directly into the ancient stone wall" |
| **Object-based** | Printed on props | "printed on a newspaper being read by the character" |


---

# Part 5: Технические параметры (пропорции, negative prompt)

> source: https://docs.bfl.ml/guides/prompting_unified_technical.md

# Technical Parameters

> Aspect ratios and working without negative prompts

export const PromptCarousel = ({slides = [], height = "500px"}) => {
  const [activeIdx, setActiveIdx] = useState(0);
  const items = slides.length > 0 ? slides : [{
    img: "https://images.unsplash.com/photo-1551963831-b3b1ca40c98e?w=800&fit=crop",
    prompt: "A cozy breakfast spread on a wooden table"
  }];
  const goTo = idx => {
    const next = Math.max(0, Math.min(items.length - 1, idx));
    setActiveIdx(next);
  };
  return <div className="not-prose" style={{
    borderRadius: "0.75rem",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "#000000",
    marginTop: 0
  }}>
      {}
      <div style={{
    position: "relative",
    width: "100%",
    height,
    overflow: "hidden"
  }}>
        <div style={{
    display: "flex",
    transition: "transform 400ms cubic-bezier(0.25, 1, 0.5, 1)",
    transform: `translateX(-${activeIdx * 100}%)`,
    height: "100%"
  }}>
          {items.map(item => <div key={item.img} style={{
    flex: "0 0 100%",
    height: "100%"
  }}>
              <img src={item.img} alt={item.prompt?.slice(0, 80) || ""} draggable={false} style={{
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
    pointerEvents: "none"
  }} />
            </div>)}
        </div>

        {items.length > 1 && <>
            <button onClick={() => goTo(activeIdx - 1)} style={{
    position: "absolute",
    top: "50%",
    left: "12px",
    transform: "translateY(-50%)",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    opacity: activeIdx === 0 ? 0.3 : 1,
    transition: "opacity 200ms"
  }} disabled={activeIdx === 0}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7L9 12" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button onClick={() => goTo(activeIdx + 1)} style={{
    position: "absolute",
    top: "50%",
    right: "12px",
    transform: "translateY(-50%)",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    border: "none",
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    opacity: activeIdx === items.length - 1 ? 0.3 : 1,
    transition: "opacity 200ms"
  }} disabled={activeIdx === items.length - 1}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2L10 7L5 12" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </>}
      </div>

      {}
      {items.length > 1 && items[0]?.title ? <div style={{
    display: "flex",
    justifyContent: "center",
    gap: "4px",
    padding: "12px 8px 4px",
    flexWrap: "wrap"
  }}>
          {items.map((item, idx) => <button key={idx} onClick={() => goTo(idx)} style={{
    padding: "4px 12px",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    fontSize: "0.7rem",
    fontWeight: activeIdx === idx ? 700 : 500,
    background: activeIdx === idx ? "rgba(255,255,255,0.15)" : "transparent",
    color: activeIdx === idx ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.45)",
    transition: "all 200ms ease"
  }}>
              {item.title}
            </button>)}
        </div> : items.length > 1 && <div style={{
    display: "flex",
    justifyContent: "center",
    gap: "8px",
    padding: "12px 0 4px"
  }}>
          {items.map((_, idx) => <button key={idx} onClick={() => goTo(idx)} style={{
    width: activeIdx === idx ? "24px" : "8px",
    height: "8px",
    borderRadius: "4px",
    border: "none",
    padding: 0,
    cursor: "pointer",
    background: activeIdx === idx ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.3)",
    transition: "all 300ms ease"
  }} />)}
        </div>}

      {}
      <div style={{
    padding: "0.5rem 0.5rem 0.6rem"
  }}>
        <div style={{
    padding: "0.6rem 0.75rem",
    borderRadius: "6px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    fontFamily: "monospace",
    fontSize: "0.75rem",
    lineHeight: 1.6,
    color: "rgba(255,255,255,0.7)",
    minHeight: "2.4rem",
    transition: "opacity 200ms ease"
  }}>
          <span style={{
    color: "rgba(255,255,255,0.35)",
    fontSize: "0.65rem",
    marginRight: "6px"
  }}>prompt:</span>
          {items[activeIdx]?.prompt || ""}
        </div>
      </div>
    </div>;
};

## Aspect Ratios

Choose the ratio that matches the compositional intent of your scene. Mismatched ratios force the model to either crop or pad the composition.

| Ratio | Format | Best For |
| - | - | - |
| **1:1** | Square | Social media, profiles, product shots |
| **16:9** | Landscape | Widescreen, web headers, presentations |
| **9:16** | Portrait | Mobile, stories, vertical editorial |
| **4:3** | Standard | Classic photography |
| **3:2** | Photo standard | DSLR-style portrait and landscape |
| **21:9** | Ultra-wide | Cinematic, panoramic scenes |

<Tip>A landscape-oriented prompt benefits from 16:9; a portrait prompt from 9:16.</Tip>

## Working Without Negative Prompts

Most FLUX models do not support negative prompts. Even when they can process them, AI models generally struggle with negation — writing *"a person without glasses"* causes the model to focus on "glasses" and often generate exactly what you were trying to avoid.

### The Replacement Strategy

When you catch yourself writing negative phrases, use this mental process:

1. **Identify** the unwanted element: *"no crowds"*
2. **Ask** what would fill that space: *"What would I see there?"*
3. **Describe** the positive: *"peaceful solitude"* or *"empty pathways"*

**Common replacements:**

| Instead of... | Write... |
| - | - |
| "no people" | "empty", "deserted", "solitary" |
| "without clothes" | "bare skin", "natural form" |
| "no colors" | "monochrome", "black and white", "grayscale" |
| "no text" | "clean surfaces", "unmarked", "blank" |
| "no modern elements" | "traditional", "historical", "period-accurate" |
| "not dark" | "brightly lit", "sun-drenched" |
| "not sad" | "joyful", "content" |
| "not running" | "walking peacefully", "standing still" |
| "not many" | "few", "single", "minimal" |

### Practical Examples

<AccordionGroup>
  <Accordion title="Context & Setting">
    * **Instead of**: "a street with no cars"
      **Write**: "a quiet pedestrian walkway with cobblestones"

    * **Instead of**: "a landscape without buildings"
      **Write**: "pristine wilderness with untouched natural terrain"

    * **Instead of**: "a room with no furniture"
      **Write**: "a spacious empty room with polished wooden floors"
  </Accordion>

  <Accordion title="Character & Portrait">
    * **Instead of**: "a person without a hat"
      **Write**: "a person with natural hair flowing freely"

    * **Instead of**: "a portrait with no glasses"
      **Write**: "a portrait showing clear, unobstructed eyes"
  </Accordion>

  <Accordion title="Mood and Atmosphere">
    * **Instead of**: "not dark or scary"
      **Write**: "peaceful, welcoming, and warm atmosphere with soft golden lighting"

    * **Instead of**: "not too realistic"
      **Write**: "stylized illustration with simplified forms and bold color blocks"
  </Accordion>

  <Accordion title="Compositional Control">
    * **Instead of**: "portrait with no background distractions"
      **Write**: "portrait with smooth gradient background transitioning from deep blue to black"
  </Accordion>
</AccordionGroup>

### The Beach Progression

Positive framing combined with specificity consistently produces better results:

<PromptCarousel
  height="400px"
  slides={[
{
  img: "https://cdn.sanity.io/images/gsvmb6gz/production/4fc2c5a86463f31bca29cb1b4ee502b5d713ccfe-1392x752.jpg",
  prompt: "A beach"
},
{
  img: "https://cdn.sanity.io/images/gsvmb6gz/production/ca548a2e74e7372b485c9d9ba72914487d196d60-1392x752.jpg",
  prompt: "Empty beach with palm trees and gentle waves"
},
{
  img: "https://cdn.sanity.io/images/gsvmb6gz/production/ca91ec2d49372239d56bb13b18a8d50bc1180305-1392x752.jpg",
  prompt: "Empty beach with palm trees and gentle waves, golden sunset, IMAX-quality look"
},
]}
/>

### When Positive Alternatives Don't Work

If you're still getting unwanted elements despite positive framing:

1. **Be more specific** about what you do want in that space
2. **Front-load the positive description** — word order signals priority
3. **Add more descriptive detail** to strengthen the positive alternative
4. **Use environmental context** to make the positive element feel natural

<Tip>Think visually about what you want to see, not what to avoid.</Tip>

## Prompt Upsampling

FLUX.2 \[pro], \[max], and \[flex] automatically enhance short prompts by adding visual detail and context while preserving your original intent. This is useful for:

* Quick iterations without crafting detailed prompts
* Exploring creative variations from a short concept
* Generating richer output from a basic idea

<Tip>
  On FLUX.2 \[klein], what you write is what you get — be descriptive. Other FLUX.2 variants are more forgiving with short prompts.
</Tip>


---

# Part 6: Шпаргалка: камера, свет, стили, примеры

> source: https://docs.bfl.ml/guides/prompting_unified_reference.md

# Prompt Reference

> Cheat sheet with camera terms, lighting and style keywords, and ready-to-use example prompts

export const PromptDisplay = ({prompt}) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <div className="not-prose" style={{
    marginTop: "1rem"
  }}>
      <div style={{
    backgroundColor: "#1a1a1a",
    borderRadius: "1rem",
    padding: "1.25rem 1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem"
  }}>
        <p style={{
    color: "#e5e5e5",
    fontSize: "1rem",
    lineHeight: 1.6,
    margin: 0,
    fontFamily: "inherit"
  }}>
          {prompt}
        </p>
        <div style={{
    display: "flex",
    justifyContent: "flex-end"
  }}>
          <button onClick={copy} style={{
    backgroundColor: copied ? "#3d8a5b" : "var(--aspen-evergreen, #486A58)",
    color: "#fff",
    border: "none",
    borderRadius: "0.375rem",
    padding: "0.25rem 0.6rem",
    fontSize: "0.7rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 0.2s"
  }}>
            {copied ? "Copied!" : "Copy prompt"}
          </button>
        </div>
      </div>
    </div>;
};

## Camera & Lens Cheat Sheet

| Term | Effect |
| - | - |
| **f/1.4 – f/2.8** | Blurry background (shallow depth of field) |
| **f/8 – f/16** | Everything sharp (deep depth of field) |
| **24mm** | Wide angle — shows more of the scene |
| **35mm** | Natural, documentary-style perspective |
| **50mm** | Eye-level, neutral perspective |
| **85mm** | Portrait-ideal, slight background compression |
| **135mm+** | Telephoto — strong background compression |
| **ISO 100** | Clean image, low noise |
| **ISO 1600–3200** | Brighter but grainy — useful for film-style looks |
| **Macro lens** | Extreme close-up detail |
| **Anamorphic lens** | Widescreen cinematic look with oval bokeh |

<PromptDisplay prompt="Shot on Hasselblad X2D, 80mm lens, f/2.8, natural lighting" />

## Lighting Keywords

| Term | Effect |
| - | - |
| **Golden hour** | Warm, soft, flattering — just after sunrise or before sunset |
| **Blue hour** | Cool, moody — just before sunrise or after sunset |
| **Overcast** | Flat, even, shadow-free — great for product shots |
| **Rembrandt lighting** | Dramatic triangle of light on the face |
| **Split lighting** | High contrast, half-face illuminated |
| **Chiaroscuro** | Strong light/shadow drama |
| **Backlit / rim light** | Subject glowing at the edges |
| **Soft box / key light** | Studio, controlled, even |
| **Practical lighting** | Light sources visible in the scene (lamps, neon, fire) |
| **Diffused light** | Soft, wrap-around, minimal shadows |
| **Harsh direct light** | Strong shadows, high contrast |

**Example lighting phrases:**

<PromptDisplay prompt="soft, diffused natural light filtering through sheer curtains" />

<PromptDisplay prompt="dramatic side lighting creating deep shadows and highlights" />

<PromptDisplay prompt="golden hour backlighting with lens flare" />

<PromptDisplay prompt="overcast light creating even, shadow-free illumination" />

## Style Keywords

| Category | Keywords |
| - | - |
| **Photographic** | "shot on Kodak Portra 400", "35mm film", "IMAX camera", "Sony A7IV", "Hasselblad X2D", "Canon 5D" |
| **Cinematic** | "cinematic", "anamorphic lens flare", "teal and orange color grading", "film noir", "Roger Deakins cinematography" |
| **Artistic** | "oil painting", "watercolor", "pencil sketch", "impasto texture", "Art Nouveau", "Bauhaus" |
| **Digital art** | "concept art", "matte painting", "octane render", "unreal engine", "stylized 3D" |
| **Illustration** | "flat design", "vector illustration", "comic art", "anime style", "graphic novel", "whimsical" |
| **Vintage** | "80s vintage photo", "2000s digicam", "VHS aesthetic", "polaroid", "sepia tone" |

## Composition Techniques

| Technique | When to Use | Example Phrase |
| - | - | - |
| **Rule of thirds** | Natural, balanced framing | "composed using rule of thirds" |
| **Leading lines** | Guide the eye through the image | "diagonal lines leading to main entrance" |
| **Foreground/background layers** | Add depth and dimension | "strong foreground boulder, background mountains" |
| **Low angle (worm's eye)** | Make subjects powerful and dominant | "low angle worm's eye view, dramatic diagonal lines" |
| **High angle (bird's eye)** | Show patterns and spatial relationships | "bird's eye view, geometric patterns of city blocks" |
| **Dutch angle** | Tension and psychological unease | "dutch angle, psychological tension" |
| **Symmetrical** | Formal, balanced, architectural | "perfectly symmetrical composition" |
| **Negative space** | Minimal, focused, product | "minimalist composition with generous negative space" |

## Model-Specific Quick Reference

<AccordionGroup>
  <Accordion title="FLUX.2 [pro] & [max]">
    * No negative prompts supported
    * Excellent typography — use quotation marks for exact text
    * HEX color codes for brand-precise color matching: `"in color #FF5733"`
    * JSON structured prompts supported for production workflows
    * Reference specific camera models for authentic photorealistic looks

    See: [JSON Prompting →](/guides/usecases_t2i_json_prompting), [Typography & Design →](/guides/usecases_t2i_typography_design), [HEX Color Prompting →](/guides/usecases_t2i_hex_color_prompting)
  </Accordion>

  <Accordion title="FLUX.2 [klein]">
    * What you write is exactly what the model receives
    * Write in prose, not keyword lists — describe scenes like a novelist
    * Lighting descriptions have the highest single impact on output quality
    * Supports image editing with single and multi-reference inputs
    * Add `Style: [style]. Mood: [mood].` at the end for consistent aesthetics

    See: [Single-Reference Editing →](/guides/prompting_editing_single_reference), [Multi-Reference Editing →](/guides/prompting_editing_multi_reference)
  </Accordion>

  <Accordion title="FLUX.1 Kontext">
    * Specify what should **change** — the input image provides all other visual context
    * Use quotation marks for text editing: `Replace 'joy' with 'BFL'`
    * Be explicit about preservation: *"while maintaining the same facial features and hairstyle"*
    * Prefer specific verbs: "change the clothes" over "transform the person"
    * For multiple changes, add as many explicit details as possible
  </Accordion>
</AccordionGroup>


---

# Part 7: Редактирование изображений (FLUX.2, референсы)

> source: https://docs.bfl.ml/guides/prompting_editing_overview.md

# Image Editing

> Overview of image editing with FLUX.2 — swap backgrounds, replace objects, transfer styles, and combine multi-reference images in natural language.

export const MultiRefGrid = ({inputs = [], result = {}, prompt = ""}) => {
  const [hoveredInput, setHoveredInput] = useState(-1);
  const colors = [{
    bg: "rgba(99,182,137,0.22)",
    border: "#63b689",
    text: "#63b689"
  }, {
    bg: "rgba(130,170,255,0.22)",
    border: "#82aaff",
    text: "#82aaff"
  }, {
    bg: "rgba(255,180,107,0.22)",
    border: "#ffb46b",
    text: "#ffb46b"
  }, {
    bg: "rgba(199,140,230,0.22)",
    border: "#c78ce6",
    text: "#c78ce6"
  }, {
    bg: "rgba(255,130,130,0.22)",
    border: "#ff8282",
    text: "#ff8282"
  }, {
    bg: "rgba(130,220,220,0.22)",
    border: "#82dcdc",
    text: "#82dcdc"
  }, {
    bg: "rgba(220,200,120,0.22)",
    border: "#dcc878",
    text: "#dcc878"
  }, {
    bg: "rgba(200,160,180,0.22)",
    border: "#c8a0b4",
    text: "#c8a0b4"
  }];
  const renderPrompt = () => {
    if (!prompt) return null;
    const parts = [];
    let lastIndex = 0;
    const re = /\b(image\s+(\d))\b/gi;
    let m;
    while ((m = re.exec(prompt)) !== null) {
      if (m.index > lastIndex) parts.push({
        text: prompt.slice(lastIndex, m.index),
        idx: -1
      });
      parts.push({
        text: m[1],
        idx: parseInt(m[2], 10) - 1
      });
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < prompt.length) parts.push({
      text: prompt.slice(lastIndex),
      idx: -1
    });
    return parts.map((p, i) => {
      if (p.idx >= 0 && p.idx < colors.length) {
        const c = colors[p.idx];
        return <span key={i} style={{
          color: c.text,
          fontWeight: 700,
          padding: "1px 5px",
          borderRadius: "3px",
          background: hoveredInput === p.idx ? c.bg : "transparent",
          transition: "background 200ms"
        }}>
            {p.text}
          </span>;
      }
      return <span key={i}>{p.text}</span>;
    });
  };
  const getGridCols = () => {
    const n = inputs.length;
    if (n <= 3) return n;
    if (n === 4) return 2;
    if (n <= 6) return 3;
    return 4;
  };
  const gridCols = getGridCols();
  return <div className="not-prose" style={{
    borderRadius: "0.75rem",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(0,0,0,0.35)"
  }}>

      {}
      <div style={{
    display: "grid",
    gridTemplateColumns: "repeat(" + gridCols + ", 1fr)",
    gap: "3px",
    padding: "3px",
    background: "rgba(0,0,0,0.3)"
  }}>
        {inputs.map((img, idx) => {
    const c = colors[idx % colors.length];
    const isHovered = hoveredInput === idx;
    return <div key={idx} onMouseEnter={() => setHoveredInput(idx)} onMouseLeave={() => setHoveredInput(-1)} style={{
      position: "relative",
      overflow: "hidden",
      cursor: "default",
      aspectRatio: "4/3",
      outline: isHovered ? "2px solid " + c.border : "2px solid transparent",
      outlineOffset: "-2px",
      transition: "outline-color 200ms ease",
      borderRadius: "4px"
    }}>
              <img src={img.src} alt={img.label || "Input " + (idx + 1)} style={{
      display: "block",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      pointerEvents: "none"
    }} />
              <div style={{
      position: "absolute",
      top: "4px",
      left: "4px",
      width: "22px",
      height: "22px",
      borderRadius: "50%",
      background: c.border,
      color: "#000",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: "0.65rem",
      fontWeight: 800,
      boxShadow: "0 1px 4px rgba(0,0,0,0.5)"
    }}>
                {idx + 1}
              </div>
            </div>;
  })}
      </div>

      {}
      <div style={{
    display: "flex",
    justifyContent: "center",
    padding: "4px 0",
    background: "rgba(0,0,0,0.3)"
  }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M6 13l6 6 6-6" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {}
      <div style={{
    position: "relative",
    padding: "0 3px 3px",
    background: "rgba(0,0,0,0.3)"
  }}>
        <img src={result.src} alt={result.label || "Result"} style={{
    display: "block",
    width: "100%",
    height: "auto",
    borderRadius: "4px",
    pointerEvents: "none"
  }} />
        <div style={{
    position: "absolute",
    top: "6px",
    right: "9px",
    padding: "3px 10px",
    borderRadius: "5px",
    background: "rgba(0,0,0,0.6)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    fontSize: "0.65rem",
    fontWeight: 600
  }}>
          Result
        </div>
      </div>

      {}
      {prompt && <div style={{
    padding: "0.4rem 0.5rem 0.5rem"
  }}>
          <div style={{
    padding: "0.4rem 0.6rem",
    borderRadius: "6px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    fontFamily: "monospace",
    fontSize: "0.68rem",
    lineHeight: 1.5,
    color: "rgba(255,255,255,0.7)"
  }}>
            <span style={{
    color: "rgba(255,255,255,0.35)",
    fontSize: "0.6rem",
    marginRight: "5px"
  }}>prompt:</span>
            {renderPrompt()}
          </div>
        </div>}
    </div>;
};

export const PromptDisplay = ({prompt}) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return <div className="not-prose" style={{
    marginTop: "1rem"
  }}>
      <div style={{
    backgroundColor: "#1a1a1a",
    borderRadius: "1rem",
    padding: "1.25rem 1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem"
  }}>
        <p style={{
    color: "#e5e5e5",
    fontSize: "1rem",
    lineHeight: 1.6,
    margin: 0,
    fontFamily: "inherit"
  }}>
          {prompt}
        </p>
        <div style={{
    display: "flex",
    justifyContent: "flex-end"
  }}>
          <button onClick={copy} style={{
    backgroundColor: copied ? "#3d8a5b" : "var(--aspen-evergreen, #486A58)",
    color: "#fff",
    border: "none",
    borderRadius: "0.375rem",
    padding: "0.25rem 0.6rem",
    fontSize: "0.7rem",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 0.2s"
  }}>
            {copied ? "Copied!" : "Copy prompt"}
          </button>
        </div>
      </div>
    </div>;
};

export const ImageComparisonSlider = ({beforeImage, afterImage, beforeLabel = "Before", afterLabel = "After", height = "500px", objectFit = "cover", garmentImage, garmentLabel = "Garment reference"}) => {
  const [position, setPosition] = useState(50);
  const dialogRef = useRef(null);
  const openLightbox = () => {
    if (dialogRef.current && typeof dialogRef.current.showModal === "function") {
      dialogRef.current.showModal();
    }
  };
  const closeLightbox = () => {
    if (dialogRef.current && typeof dialogRef.current.close === "function") {
      dialogRef.current.close();
    }
  };
  const getPosition = (e, container) => {
    const rect = container.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = clientX - rect.left;
    return Math.max(0, Math.min(100, x / rect.width * 100));
  };
  const onPointerDown = e => {
    e.preventDefault();
    e.stopPropagation();
    const container = e.currentTarget;
    setPosition(getPosition(e, container));
    const onMove = ev => {
      ev.preventDefault();
      setPosition(getPosition(ev, container));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, {
      passive: false
    });
    window.addEventListener("touchend", onUp);
  };
  return <div className="not-prose" style={{
    borderRadius: "1rem",
    overflow: "hidden",
    height,
    width: "100%"
  }}>
      <div onMouseDown={onPointerDown} onTouchStart={onPointerDown} onClick={e => {
    e.preventDefault();
    e.stopPropagation();
  }} style={{
    position: "relative",
    width: "100%",
    height,
    overflow: "hidden",
    cursor: "ew-resize",
    userSelect: "none",
    WebkitUserSelect: "none"
  }}>
        {}
        <img src={afterImage} alt={afterLabel} draggable={false} style={{
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit,
    pointerEvents: "none"
  }} />

        {}
        <div style={{
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    clipPath: `inset(0 ${100 - position}% 0 0)`
  }}>
          <img src={beforeImage} alt={beforeLabel} draggable={false} style={{
    display: "block",
    width: "100%",
    height: "100%",
    objectFit,
    pointerEvents: "none"
  }} />
        </div>

        {}
        <div style={{
    position: "absolute",
    top: 0,
    left: `${position}%`,
    transform: "translateX(-50%)",
    width: "3px",
    height: "100%",
    background: "rgba(255,255,255,0.85)",
    pointerEvents: "none",
    zIndex: 2
  }} />

        {}
        <div style={{
    position: "absolute",
    top: "50%",
    left: `${position}%`,
    transform: "translate(-50%, -50%)",
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    background: "rgba(255,255,255,0.95)",
    border: "2px solid rgba(0,0,0,0.15)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    zIndex: 3,
    pointerEvents: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)"
  }}>
          {}
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none" style={{
    marginRight: "-2px"
  }}>
            <path d="M8 1L2 7L8 13" stroke="#333" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {}
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none" style={{
    marginLeft: "-2px"
  }}>
            <path d="M2 1L8 7L2 13" stroke="#333" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {}
        <div style={{
    position: "absolute",
    top: "12px",
    left: "12px",
    padding: "4px 10px",
    borderRadius: "6px",
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    fontSize: "0.75rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
    pointerEvents: "none",
    zIndex: 4
  }}>
          {beforeLabel}
        </div>
        <div style={{
    position: "absolute",
    top: "12px",
    right: "12px",
    padding: "4px 10px",
    borderRadius: "6px",
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(4px)",
    color: "#fff",
    fontSize: "0.75rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
    pointerEvents: "none",
    zIndex: 4
  }}>
          {afterLabel}
        </div>

        {}
        {garmentImage && <div onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()} onClick={e => {
    e.preventDefault();
    e.stopPropagation();
    openLightbox();
  }} title={`${garmentLabel} — click to enlarge`} style={{
    position: "absolute",
    bottom: "12px",
    right: "12px",
    height: "140px",
    maxWidth: "40%",
    borderRadius: "8px",
    overflow: "hidden",
    cursor: "zoom-in",
    background: "rgba(255,255,255,0.95)",
    border: "2px solid rgba(255,255,255,0.9)",
    boxShadow: "0 2px 12px rgba(0,0,0,0.45)",
    zIndex: 5,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  }}>
            <img src={garmentImage} alt={garmentLabel} draggable={false} style={{
    height: "100%",
    width: "auto",
    objectFit: "contain",
    pointerEvents: "none"
  }} />
          </div>}
      </div>

      {}
      {garmentImage && <dialog ref={dialogRef} onClick={closeLightbox} onClose={closeLightbox} style={{
    padding: 0,
    border: "none",
    background: "transparent",
    maxWidth: "100vw",
    maxHeight: "100vh",
    width: "100vw",
    height: "100vh",
    overflow: "hidden"
  }}>
          <div onClick={closeLightbox} style={{
    width: "100vw",
    height: "100vh",
    background: "rgba(0,0,0,0.88)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "zoom-out",
    padding: "40px",
    boxSizing: "border-box"
  }}>
            <img src={garmentImage} alt={garmentLabel} onClick={e => e.stopPropagation()} style={{
    maxWidth: "90vw",
    maxHeight: "90vh",
    objectFit: "contain",
    borderRadius: "8px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    cursor: "default"
  }} />
          </div>
        </dialog>}
    </div>;
};

export const EditingShowcase = () => {
  const [activeId, setActiveId] = useState("starting");
  const categories = [{
    id: "starting",
    title: "Starting Image",
    description: "The original image before any edits.",
    prompt: "A lone wolf standing on a rocky outcropping, bathed in golden light. The wind ruffles its thick grey fur as it gazes across a vast wilderness landscape.",
    image: "https://cdn.sanity.io/images/2gpum2i6/production/03cb44b883709a79500c46d8db8e0d0fc932413d-1440x1024.png"
  }, {
    id: "character",
    title: "Change the character",
    description: "Replace or transform people and creatures in your scene.",
    prompt: "Replace the wolf with a large silver fox, keeping the same pose \u2014 head tilted up, howling. The fox has a thick, bushy tail and piercing amber eyes. It stands in the same spot on the factory floor.",
    image: "https://cdn.sanity.io/images/2gpum2i6/production/da47586dc36c5a66fbeba00d6f124bf9dee6a2c9-1440x1024.png"
  }, {
    id: "composition",
    title: "Adjust the Composition",
    description: "Reframe and restructure your image.",
    prompt: "Zoom out to reveal more of the abandoned factory interior. Show towering rusted machinery on both sides, a collapsed roof section letting in dramatic shafts of light, and debris scattered across a vast concrete floor.",
    image: "https://cdn.sanity.io/images/2gpum2i6/production/ca941af1f2c7eddc09c50937b7f3f381fa686e42-1440x1024.png"
  }, {
    id: "action",
    title: "Alter the Action",
    description: "Change what the subject is doing.",
    prompt: "The wolf is now lying down peacefully on the factory floor, resting its head on its front paws. Eyes half-closed, calm and relaxed. A small bird has landed on its back.",
    image: "https://cdn.sanity.io/images/2gpum2i6/production/798b153d0e8228f1db3974cdfbeeb88701bc5d54-1440x1024.png"
  }, {
    id: "setting",
    title: "Swap the Setting",
    description: "Transform the environment, as much or as little as you like.",
    prompt: "Change the setting from a natural rock outcropping to have the wolf on the floor of a cavernous, abandoned factory. Shafts of light from shattered skylights pierce the dusty gloom, and illuminate silent, colossal machinery in the background.",
    image: "https://cdn.sanity.io/images/2gpum2i6/production/d4b701dab8e201072f6726175f1b9381b77ae769-1440x1024.png"
  }];
  const active = categories.find(c => c.id === activeId) || categories[0];
  return <div className="not-prose" style={{
    borderRadius: "1rem",
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "#111210"
  }}>
      <div style={{
    position: "relative",
    aspectRatio: "16/9",
    overflow: "hidden"
  }}>
        <img src={active.image} alt={active.title} style={{
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "cover"
  }} />
        <div style={{
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: "2rem 1.5rem 1.25rem",
    background: "linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.85) 100%)"
  }}>
          <p style={{
    margin: 0,
    color: "rgba(255,255,255,0.88)",
    fontFamily: "monospace",
    fontSize: "0.82rem",
    lineHeight: 1.65,
    maxWidth: "48rem"
  }}>
            {active.prompt}
          </p>
        </div>
      </div>
      <div style={{
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "0"
  }}>
        {categories.map(cat => {
    const isActive = cat.id === activeId;
    return <button key={cat.id} onClick={() => setActiveId(cat.id)} style={{
      display: "block",
      width: "100%",
      padding: "1rem 1.25rem",
      border: "none",
      borderRight: "1px solid rgba(255,255,255,0.08)",
      background: isActive ? "rgba(255,255,255,0.06)" : "transparent",
      textAlign: "left",
      cursor: "pointer",
      color: "#f5f5f5",
      borderTop: isActive ? "2px solid rgba(255,255,255,0.5)" : "2px solid transparent"
    }}>
              <div style={{
      fontWeight: 600,
      fontSize: "0.9rem",
      color: isActive ? "#fff" : "rgba(255,255,255,0.6)"
    }}>
                {cat.title}
              </div>
            </button>;
  })}
      </div>
    </div>;
};

FLUX.2 brings powerful image editing capabilities across the entire model family. Describe what you want changed in natural language — swap backgrounds, replace objects, transfer styles, adjust lighting — and FLUX.2 makes it happen while maintaining photorealism.

All **FLUX.2** variants support multi-reference image editing, allowing you to combine elements from multiple source images into a single coherent result.

<EditingShowcase />

## Reference Images per Model

| Model | Reference Images (API) | Reference Images (Playground) |
| - | - | - |
| **FLUX.2 \[max]** | Up to **8** | Up to **10** |
| **FLUX.2 \[pro]** | Up to **8** | Up to **10** |
| **FLUX.2 \[flex]** | Up to **8** | Up to **10** |
| **FLUX.2 \[klein] 9B** | Up to **4** | — |
| **FLUX.2 \[klein] 4B** | Up to **4** | — |
| **FLUX.2 \[dev]** | Recommended max **6** | — |

<Tip>
  More reference images means more control. Use multiple inputs to maintain character consistency, combine furniture from different photos, or transfer styles — all in a single generation.
</Tip>

## Single Editing Example

<ImageComparisonSlider beforeImage="https://cdn.sanity.io/images/2gpum2i6/production/ca563be7241d46f06868a7aae876098ce8520588-1440x960.png" afterImage="https://cdn.sanity.io/images/2gpum2i6/production/b200442e944e6f1f58a91443dd82e64f8eb753c4-1549x1033.jpg" beforeLabel="Original" afterLabel="Edited" height="500px" />

<PromptDisplay prompt="Change it to Night" />

## Multi-Reference Example

<MultiRefGrid
  inputs={[
{ src: "https://cdn.sanity.io/images/2gpum2i6/production/669126258fdc53965be6d8168180b298755d5db1-1125x750.png", label: "Ice Skates" },
{ src: "https://cdn.sanity.io/images/2gpum2i6/production/5c022629eb46a126547ea685a5bedb145288875c-1125x750.png", label: "Location" },
{ src: "https://cdn.sanity.io/images/2gpum2i6/production/c00b05340b6dc9807e492efa7cd85277d4fc7201-500x331.png", label: "Decorations" },
]}
  result={{ src: "https://cdn.sanity.io/images/2gpum2i6/production/31acfcff514f52c13abb3a7327d4d74aeb35103c-1120x736.png" }}
  prompt="Create a vintage image taken with a Kodak camera, with heavy grain and slight light smudges. Use Image 2 as the location. Insert only the ice skates from Image 1 into Image 2, with the decorations and evening lighting vibe from Image 3. Add more people skating on the ice."
/>

<CardGroup cols={2}>
  <Card title="FLUX.2 Editing" icon="wand-magic-sparkles" href="/flux_2/flux2_image_editing">
    Full editing documentation with API examples, parameters, and multi-reference techniques.
  </Card>

  <Card title="Editing Prompting Guide" icon="pen-to-square" href="/guides/prompting_editing_single_reference">
    Learn how to write effective prompts for image editing workflows.
  </Card>
</CardGroup>


---

# Part 8: JSON-структурированные промпты

> source: https://docs.bfl.ml/guides/usecases_t2i_json_prompting.md

# JSON Structured Prompting

> Use structured JSON prompts for precise control over complex scenes

For complex scenes and production workflows, FLUX.2 interprets structured JSON prompts, giving you precise control over every aspect of your image.

**When to use JSON**:

* Production workflows requiring consistent structure
* Automation and programmatic generation
* Complex scenes with multiple subjects and relationships
* When you need to iterate on specific elements independently

**When natural language works better**:

* Quick iterations and exploration
* Simple, single-subject scenes
* When prompt length isn't a concern
* Creative workflows where flexibility matters

FLUX.2 understands both formats equally well—choose based on your workflow needs.

## The Base Schema

```json theme={null}
{
  "scene": "overall scene description",
  "subjects": [
    {
      "description": "detailed subject description",
      "position": "where in frame",
      "action": "what they're doing"
    }
  ],
  "style": "artistic style",
  "color_palette": ["#hex1", "#hex2", "#hex3"],
  "lighting": "lighting description",
  "mood": "emotional tone",
  "background": "background details",
  "composition": "framing and layout",
  "camera": {
    "angle": "camera angle",
    "lens": "lens type",
    "depth_of_field": "focus behavior"
  }
}
```

## Building a Prompt Step by Step

Let's build a product shot incrementally to see how each element contributes.

### Step 1: Generating a coffee mug

```json theme={null}
{
  "scene": "Professional studio product photography setup with polished concrete surface",
  "subjects": [
    {
      "description": "Minimalist ceramic coffee mug with steam rising from hot coffee inside",
      "pose": "Stationary on surface",
      "position": "Center foreground on polished concrete surface",
      "color_palette": ["matte black ceramic"]
    }
  ],
  "style": "Ultra-realistic product photography with commercial quality",
  "color_palette": ["matte black", "concrete gray", "soft white highlights"],
  "lighting": "Three-point softbox setup creating soft, diffused highlights with no harsh shadows",
  "mood": "Clean, professional, minimalist",
  "background": "Polished concrete surface with studio backdrop",
  "composition": "rule of thirds",
  "camera": {
    "angle": "high angle",
    "distance": "medium shot",
    "focus": "Sharp focus on steam rising from coffee and mug details",
    "lens-mm": 85,
    "f-number": "f/5.6",
    "ISO": 200
  }
}
```

<Frame caption="Step 1: Single matte black mug with steam">
  ![Professional product shot of a single black coffee mug with steam](https://cdn.sanity.io/images/2gpum2i6/production/037c25d7ee0500d7f795b7fdd7d05a6c779ff5bd-1024x768.webp)
</Frame>

### Step 2: Adding a second mug in a different color

```json theme={null}
{
  "scene": "Professional studio product photography setup with polished concrete surface",
  "subjects": [
    {
      "description": "Minimalist ceramic coffee mug with steam rising from hot coffee inside",
      "pose": "Stationary on surface",
      "position": "Center foreground on polished concrete surface",
      "color_palette": ["matte black ceramic"]
    },
    {
      "description": "Minimalist ceramic coffee mug, matching design to the black mug",
      "pose": "Stationary on surface",
      "position": "Right side of the black mug on polished concrete surface",
      "color_palette": ["matte yellow ceramic"]
    }
  ],
  "style": "Ultra-realistic product photography with commercial quality",
  "color_palette": ["matte black", "matte yellow", "concrete gray", "soft white highlights"],
  "lighting": "Three-point softbox setup creating soft, diffused highlights with no harsh shadows",
  "mood": "Clean, professional, minimalist",
  "background": "Polished concrete surface with studio backdrop",
  "composition": "rule of thirds",
  "camera": {
    "angle": "high angle",
    "distance": "medium shot",
    "focus": "Sharp focus on steam rising from coffee and both mugs in frame",
    "lens-mm": 85,
    "f-number": "f/5.6",
    "ISO": 200
  }
}
```

<Frame caption="Step 2: Added a yellow mug to the composition">
  ![Product shot with black and yellow coffee mugs](https://cdn.sanity.io/images/2gpum2i6/production/d56be2a807b5923e15964eae6132f79bce66be22-1024x768.webp)
</Frame>

### Step 3: Change the color of the steam

```json theme={null}
{
  "scene": "Professional studio product photography setup with polished concrete surface",
  "subjects": [
    {
      "description": "Minimalist ceramic coffee mug with bright red steam rising from hot coffee inside",
      "pose": "Stationary on surface",
      "position": "Center foreground on polished concrete surface",
      "color_palette": ["matte black ceramic", "bright red steam"]
    },
    {
      "description": "Minimalist ceramic coffee mug, matching design to the black mug",
      "pose": "Stationary on surface",
      "position": "Right side of the black mug on polished concrete surface",
      "color_palette": ["matte yellow ceramic"]
    }
  ],
  "style": "Ultra-realistic product photography with commercial quality",
  "color_palette": ["matte black", "matte yellow", "bright red", "concrete gray", "soft white highlights"],
  "lighting": "Three-point softbox setup creating soft, diffused highlights with no harsh shadows",
  "mood": "Clean, professional, minimalist",
  "background": "Polished concrete surface with studio backdrop",
  "composition": "rule of thirds",
  "camera": {
    "angle": "high angle",
    "distance": "medium shot",
    "focus": "Sharp focus on steam rising from coffee and both mugs in frame",
    "lens-mm": 85,
    "f-number": "f/5.6",
    "ISO": 200
  }
}
```

<Frame caption="Step 3: Changed the steam color to bright red">
  ![Product shot with black and yellow mugs, red steam rising from the black mug](https://cdn.sanity.io/images/2gpum2i6/production/50a2056e955f4f231e7968e69c3a89fd7d78270d-1024x768.webp)
</Frame>

<Tip>
  You can include the JSON directly in your prompt, or flatten it into natural language. FLUX.2 understands both formats.
</Tip>

<Note>
  For precise brand color matching with hex codes, see [HEX Color Prompting](/guides/usecases_t2i_hex_color_prompting).
</Note>

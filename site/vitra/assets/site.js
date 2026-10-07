// Vitra site: scroll reveals, the hero screenshot settling flat as you
// scroll, and the screen tour. Everything degrades to a static page.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Reveal sections as they enter the viewport.
  const items = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    items.forEach((el) => io.observe(el));
  }

  // Hero: tilted back at the top, flat by the time it's in full view.
  const frame = document.querySelector(".hero-shot .frame");
  if (frame && !reduced) {
    let ticking = false;
    const update = () => {
      ticking = false;
      const r = frame.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, 1 - (r.top - innerHeight * 0.2) / (innerHeight * 0.6)));
      frame.style.setProperty("--tilt-x", `${(8 * (1 - t)).toFixed(2)}deg`);
    };
    addEventListener("scroll", () => ticking || ((ticking = true), requestAnimationFrame(update)), { passive: true });
    update();
  }

  // Tour: tabs switch screenshots; auto-advances until someone picks a tab.
  const tabs = [...document.querySelectorAll(".tour-tabs button")];
  const slides = [...document.querySelectorAll(".tour-stage img")];
  const caption = document.querySelector(".tour-caption");
  if (!tabs.length) return;
  let index = 0;
  let timer = null;
  const show = (i) => {
    index = (i + tabs.length) % tabs.length;
    tabs.forEach((t, j) => t.setAttribute("aria-selected", String(j === index)));
    slides.forEach((s, j) => s.classList.toggle("on", j === index));
    if (caption) caption.textContent = tabs[index].dataset.caption;
  };
  tabs.forEach((t, i) =>
    t.addEventListener("click", () => {
      clearInterval(timer);
      show(i);
    }),
  );
  document.querySelector(".tour-tabs")?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    clearInterval(timer);
    show(index + (e.key === "ArrowRight" ? 1 : -1));
    tabs[index].focus();
  });
  show(0);
  if (!reduced) {
    // Only cycle while the tour is on screen.
    const stage = document.querySelector(".tour-stage");
    let visible = false;
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(stage);
    timer = setInterval(() => visible && !document.hidden && show(index + 1), 5200);
  }
})();

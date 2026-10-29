const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- AI provayder sozlamalari ---
// Bepul: Gemini (default), Groq, OpenRouter - hammasi OpenAI-mos endpoint.
// Render -> Environment: LLM_API_KEY (majburiy), LLM_BASE_URL, LLM_MODEL (vergul bilan bir nechta model).
const LLM_KEY = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
const LLM_BASE = (process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
const LLM_MODELS = (process.env.LLM_MODEL || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map((x) => x.trim()).filter(Boolean);
// Ixtiyoriy: Anthropic (pullik), faqat LLM_API_KEY bo'lmasa ishlatiladi.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.MODEL || "claude-sonnet-5-5";
const API_KEY = LLM_KEY || ANTHROPIC_KEY;
const SECRET = crypto
  .createHash("sha256")
  .update(process.env.APP_SECRET || API_KEY || "dev-secret")
  .digest();

const SECTION_MIN = 60; // har bir blok uchun minimal ball
const AVG_MIN = 70; // o'rtacha minimal ball

const THEMES = [
  "Work and careers", "Environment and climate", "Technology and AI",
  "Education and learning", "Health and lifestyle", "Travel and culture",
  "Media and news", "Society and relationships", "Money and consumer habits",
  "Science and discovery",
];
const GRAMMAR = [
  "second and third conditionals", "passive voice (all tenses)", "reported speech",
  "relative clauses", "modals of deduction and speculation", "wish / if only",
  "inversion and emphasis", "linking words (however, although, whereas)",
  "mixed tenses and time expressions", "gerund vs infinitive",
];

// ---------- yordamchilar ----------
async function claude(system, user, maxTokens) {
  if (LLM_KEY) return openaiCompat(system, user, maxTokens);
  if (ANTHROPIC_KEY) return anthropic(system, user, maxTokens);
  throw new Error("NO_KEY");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openaiCompat(system, user, maxTokens) {
  let lastErr = "AI xatosi";
  for (const model of LLM_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(LLM_BASE + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + LLM_KEY },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens + 4000, // "thinking" modellar uchun zaxira
            temperature: 0.6,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
          const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
          if (t) return t;
          lastErr = "AI bo‘sh javob qaytardi";
          continue;
        }
        const e = Array.isArray(d) ? d[0] && d[0].error : d.error;
        lastErr = (e && e.message) || "AI xatosi " + r.status + " (" + model + ")";
        if (r.status === 429 || r.status >= 500) { await sleep(1500); continue; } // qayta urin
        break; // 4xx (masalan model topilmadi): keyingi modelga o'tamiz
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  throw new Error(lastErr);
}

async function anthropic(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || "AI xatosi");
  return d.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

function parseJSON(t) {
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("AI javobi noto‘g‘ri formatda. Qayta urinib ko‘ring.");
  return JSON.parse(t.slice(a, b + 1));
}

// To'g'ri javoblar mijozga ochiq yuborilmaydi: shifrlangan "sealed" ichida qaytadi.
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", SECRET, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function unseal(s) {
  const b = Buffer.from(s, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", SECRET, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
}

const wc = (s) => ((s || "").trim().match(/\S+/g) || []).length;
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const strip = (qs) => qs.map(({ q, options }) => ({ q, options }));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    const noKey = e.message === "NO_KEY";
    res.status(noKey ? 503 : 500).json({
      error: noKey
        ? "Serverda LLM_API_KEY sozlanmagan. Render → Environment bo‘limiga Gemini kalitini qo‘shing."
        : e.message,
    });
  }
};

// ---------- API ----------
app.get("/api/status", (req, res) => res.json({ ai: !!API_KEY }));

const DAY_SYSTEM = `You are a strict, experienced examiner and coach for the CEFR Multilevel exam (Uzbekistan), target level B2.
Return ONLY valid JSON, no markdown, no commentary. All content must be in English.
Vary the position of the correct option (do not always use the same index).`;

app.post("/api/day", wrap(async (req, res) => {
  const day = Math.max(1, Math.min(200, parseInt(req.body.day, 10) || 1));
  const level = String(req.body.level || "B1").slice(0, 3);
  const weak = Array.isArray(req.body.weak) ? req.body.weak.slice(0, 5) : [];
  const theme = THEMES[(day - 1) % THEMES.length];
  const grammar = GRAMMAR[(day - 1) % GRAMMAR.length];
  const task1 = day % 2 === 1;
  const minWords = task1 ? 120 : 200;
  const difficulty =
    ["A1", "A2", "B1"].includes(level) && day <= 14
      ? "upper B1 rising towards B2"
      : day > 45 ? "solid B2 with a few C1 items" : "B2";

  const user = `Create the full study pack for Day ${day}.
Learner's estimated level: ${level}. Difficulty: ${difficulty}. Theme: ${theme}. Grammar focus for vocabulary-quiz sentences: ${grammar}.
Weak skills to stress slightly: ${weak.join(", ") || "none yet"}.
Writing: ${task1 ? "Task 1 (formal or informal letter/email, minimum 120 words)" : "Task 2 (opinion or discussion essay, minimum 200 words)"}.

JSON schema (exact counts):
{"theme":"","vocab":[10 x {"word":"","pos":"","definition":"","example":""}],
"vocabQuiz":[8 x {"q":"sentence containing ___","options":["","","",""],"answer":0}],
"reading":{"title":"","text":"300-380 word passage","questions":[5 x {"q":"","options":["","","",""],"answer":0}]},
"listening":{"script":"130-170 word monologue or dialogue, natural spoken English","questions":[5 x {"q":"","options":["","","",""],"answer":0}]},
"writing":{"type":"${task1 ? "Task 1" : "Task 2"}","prompt":"","minWords":${minWords}},
"speaking":{"prompt":"a Multilevel-style speaking prompt on the theme","points":["","",""]}}
vocabQuiz must test the 10 vocab words and the grammar focus. Reading and listening questions must be answerable only from the text.`;

  const d = parseJSON(await claude(DAY_SYSTEM, user, 6000));
  const ok =
    d.vocab?.length >= 8 && d.vocabQuiz?.length >= 6 &&
    d.reading?.questions?.length >= 4 && d.listening?.questions?.length >= 4 &&
    d.writing?.prompt && d.speaking?.prompt;
  if (!ok) throw new Error("Vazifa to‘liq yaratilmadi. Qayta urinib ko‘ring.");

  const sealed = seal({
    vocab: d.vocabQuiz.map((q) => q.answer),
    reading: d.reading.questions.map((q) => q.answer),
    listening: d.listening.questions.map((q) => q.answer),
    wmin: minWords,
    wtype: d.writing.type,
    wprompt: d.writing.prompt,
    sprompt: d.speaking.prompt,
  });

  res.json({
    sealed,
    data: {
      theme: d.theme || theme,
      vocab: d.vocab,
      vocabQuiz: strip(d.vocabQuiz),
      reading: { title: d.reading.title, text: d.reading.text, questions: strip(d.reading.questions) },
      listening: { script: d.listening.script, questions: strip(d.listening.questions) },
      writing: { type: d.writing.type, prompt: d.writing.prompt, minWords },
      speaking: d.speaking,
    },
  });
}));

const GRADER = `You are a strict CEFR Multilevel examiner. Grade as the real exam would.
Scoring guide (0-100): 90+ = C1 quality; 70-89 = secure B2; 60-69 = borderline B2; 40-59 = B1; below 40 = A2 or off-task.
Penalise: off-topic answers, missing task requirements, weak organisation, limited range, repeated grammar errors.
Return ONLY valid JSON. Write "feedback" in Uzbek (Latin script), concise and specific; keep examples in English.
Format: {"writing":{"score":0,"cefr":"","feedback":"","fixes":[{"wrong":"","right":"","why":""}]},
"speaking":{"score":0,"cefr":"","feedback":"","fixes":[{"wrong":"","right":"","why":""}]}}
Use null for a part that was not provided. Give at most 6 fixes per part, choosing the most important errors.`;

app.post("/api/grade", wrap(async (req, res) => {
  const { sealed, vocab = [], reading = [], listening = [] } = req.body;
  const writing = String(req.body.writing || "");
  const speaking = String(req.body.speaking || "");
  const k = unseal(sealed);

  const pct = (a, key) =>
    Math.round((100 * key.filter((x, i) => Number(a[i]) === Number(x)).length) / key.length);
  const sections = {
    vocabulary: pct(vocab, k.vocab),
    reading: pct(reading, k.reading),
    listening: pct(listening, k.listening),
    writing: 0,
    speaking: 0,
  };

  const notes = [];
  const wOK = wc(writing) >= Math.round(k.wmin * 0.8);
  const sOK = wc(speaking) >= 50;
  if (!wOK) notes.push(`Writing juda qisqa (${wc(writing)} so‘z, kamida ${Math.round(k.wmin * 0.8)} kerak): 0 ball.`);
  if (!sOK) notes.push(`Speaking juda qisqa (${wc(speaking)} so‘z, kamida 50 kerak): 0 ball.`);

  let fb = { writing: null, speaking: null };
  if (wOK || sOK) {
    const payload = {
      writing: wOK ? { task: k.wtype, prompt: k.wprompt, minWords: k.wmin, text: writing } : null,
      speaking: sOK ? { prompt: k.sprompt, transcript: speaking } : null,
    };
    fb = parseJSON(await claude(GRADER, JSON.stringify(payload), 3000));
    if (wOK && fb.writing) sections.writing = clamp(fb.writing.score);
    if (sOK && fb.speaking) sections.speaking = clamp(fb.speaking.score);
  }

  const vals = Object.values(sections);
  const average = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  const failed = Object.entries(sections).filter(([, v]) => v < SECTION_MIN).map(([n]) => n);
  const passed = failed.length === 0 && average >= AVG_MIN;

  res.json({
    sections, average, passed, failed, notes, feedback: fb,
    correct: { vocab: k.vocab, reading: k.reading, listening: k.listening },
    rules: { sectionMin: SECTION_MIN, avgMin: AVG_MIN },
  });
}));

app.post("/api/placement-writing", wrap(async (req, res) => {
  const text = String(req.body.text || "");
  if (wc(text) < 50) throw new Error("Kamida 50 so‘z yozing.");
  const sys = `You are a CEFR examiner. Estimate the writer's CEFR level (A1, A2, B1, B2, C1) from the text.
Return ONLY JSON: {"cefr":"","score":0,"feedback":"2-3 sentences in Uzbek (Latin script) about strengths and main weaknesses"}`;
  res.json(parseJSON(await claude(sys, text.slice(0, 4000), 800)));
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("B2 prep running on " + PORT));

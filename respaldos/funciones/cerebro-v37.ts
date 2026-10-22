import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const GITHUB_OWNER = "apolobelden-sketch";
const GITHUB_REPO = "Cerebro-ia";
const GITHUB_BRANCH = "main";

// Modelos Gemini en orden de preferencia. Si el primero esta saturado se prueba el siguiente.
const MODELOS_GEMINI = (Deno.env.get("GEMINI_MODELOS") ?? "gemini-3.6-flash,gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cerebro-clave",
};

function sinAcentos(str: string) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function limpiarCodigo(texto: string) {
  const m = texto.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return m ? m[1].trim() : texto.trim();
}

function base64Utf8(str: string) {
  return btoa(unescape(encodeURIComponent(str)));
}

function extraerNombreArchivo(pregunta: string, preguntaSinAcentos: string) {
  // Prueba varias formas de decir el nombre del archivo: "como X", "llamada X", "llamado X", "con el nombre X", "nombrado X"
  const patrones = [
    /(?:como|llamada|llamado|nombrada|nombrado|con el nombre)\s+['"]?([a-zA-Z0-9_\-\/]+\.[a-zA-Z]{2,5})['"]?/i,
  ];
  for (const p of patrones) {
    const m = pregunta.match(p);
    if (m) return m[1];
  }
  // Si no encuentra frase pero SI hay un nombre de archivo suelto en el texto (ej: "prueba.html")
  const suelto = pregunta.match(/\b([a-zA-Z0-9_\-]+\.(?:html|htm))\b/i);
  if (suelto) return suelto[1];
  return "salida.html";
}

async function publicarEnGitHub(path: string, contenido: string, mensaje: string) {
  if (!GITHUB_TOKEN) {
    throw new Error("No hay GITHUB_TOKEN configurado en los secretos de Supabase.");
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "cerebro-ia-bot",
  };

  let sha: string | undefined;
  const existente = await fetch(`${apiUrl}?ref=${GITHUB_BRANCH}`, { headers });
  if (existente.ok) {
    const data = await existente.json();
    sha = data.sha;
  }

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: mensaje,
      content: base64Utf8(contenido),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Error de GitHub (${res.status}): ${data?.message ?? JSON.stringify(data)}`);
  }

  return `https://${GITHUB_OWNER}.github.io/${GITHUB_REPO}/${path}`;
}

async function buscarEnInternet(consulta: string) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(consulta)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    if (!res.ok) return { texto: "", fuentes: [] as string[] };
    const data = await res.json();

    const partes: string[] = [];
    const fuentes: string[] = [];

    if (data.AbstractText) {
      partes.push(`- ${data.AbstractText}${data.AbstractURL ? " (" + data.AbstractURL + ")" : ""}`);
      if (data.AbstractURL) fuentes.push(data.AbstractURL);
    }

    const relacionados = (data.RelatedTopics ?? []).slice(0, 5);
    for (const r of relacionados) {
      if (r.Text) {
        partes.push(`- ${r.Text}${r.FirstURL ? " (" + r.FirstURL + ")" : ""}`);
        if (r.FirstURL) fuentes.push(r.FirstURL);
      }
    }

    return { texto: partes.join("\n"), fuentes };
  } catch {
    return { texto: "", fuentes: [] as string[] };
  }
}

// ---------------------------------------------------------------
// CAPA DE IA: Gemini con reintentos + modelos de respaldo + proveedores opcionales (Groq / OpenRouter)
// ---------------------------------------------------------------

class ErrorIA extends Error {
  status: number;
  constructor(mensaje: string, status: number) {
    super(mensaje);
    this.status = status;
  }
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 0 = error de red o timeout
const REINTENTABLE = new Set([0, 408, 429, 500, 502, 503, 504]);

async function pedirJSON(url: string, init: RequestInit, nombre: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    throw new ErrorIA(`${nombre}: error de red o tiempo agotado (${String((e as Error)?.message ?? e)})`, 0);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detalle = data?.error?.message || (data ? JSON.stringify(data).slice(0, 300) : "sin detalle");
    throw new ErrorIA(`Error de la API de ${nombre} (${res.status}): ${detalle}`, res.status);
  }
  return data;
}

async function geminiUnaVez(modelo: string, system: string, mensaje: string, temperatura: number) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;
  const data = await pedirJSON(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: mensaje }] }],
      generationConfig: { temperature: temperatura, maxOutputTokens: 8192 },
    }),
  }, `Gemini ${modelo}`);

  const texto = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n");
  if (!texto) {
    throw new ErrorIA(`Gemini ${modelo} respondió sin texto: ` + JSON.stringify(data).slice(0, 300), 502);
  }
  return texto as string;
}

async function compatibleUnaVez(
  nombre: string,
  url: string,
  key: string,
  modelo: string,
  system: string,
  mensaje: string,
  temperatura: number,
) {
  const data = await pedirJSON(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: modelo,
      messages: [
        { role: "system", content: system },
        { role: "user", content: mensaje },
      ],
      temperature: temperatura,
      max_tokens: 4096,
    }),
  }, nombre);

  const texto = data?.choices?.[0]?.message?.content;
  if (!texto) {
    throw new ErrorIA(`${nombre} respondió sin texto`, 502);
  }
  return texto as string;
}

async function conReintentos<T>(fn: () => Promise<T>, intentos: number): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      const st = e instanceof ErrorIA ? e.status : -1;
      if (!REINTENTABLE.has(st)) throw e;
      if (i < intentos - 1) await dormir(i === 0 ? 2000 : 5000);
    }
  }
  throw ultimo;
}

async function llamarIA(system: string, mensaje: string, temperatura: number) {
  const proveedores: { nombre: string; intentos: number; fn: () => Promise<string> }[] = MODELOS_GEMINI.map((m, i) => ({
    nombre: i === 0 ? "gemini" : `gemini:${m}`,
    intentos: i === 0 ? 3 : 2,
    fn: () => geminiUnaVez(m, system, mensaje, temperatura),
  }));

  const groqKey = (Deno.env.get("GROQ_API_KEY") ?? "").trim();
  // Si no existe el secreto GROQ_MODEL se usa gpt-oss-120b (probado y gratis en Groq).
  const groqModel = Deno.env.get("GROQ_MODEL") || "openai/gpt-oss-120b";
  if (groqKey && groqModel) {
    proveedores.push({
      nombre: "groq",
      intentos: 2,
      fn: () =>
        compatibleUnaVez(
          "Groq",
          "https://api.groq.com/openai/v1/chat/completions",
          groqKey,
          groqModel,
          system,
          mensaje,
          temperatura,
        ),
    });
  }

  const orKey = Deno.env.get("OPENROUTER_API_KEY") ?? "";
  const orModel = Deno.env.get("OPENROUTER_MODEL") ?? "";
  if (orKey && orModel) {
    proveedores.push({
      nombre: "openrouter",
      intentos: 2,
      fn: () =>
        compatibleUnaVez(
          "OpenRouter",
          "https://openrouter.ai/api/v1/chat/completions",
          orKey,
          orModel,
          system,
          mensaje,
          temperatura,
        ),
    });
  }

  const fallos: string[] = [];
  for (const p of proveedores) {
    try {
      const texto = await conReintentos(p.fn, p.intentos);
      return { texto, proveedor: p.nombre };
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 220);
      console.error(`Proveedor ${p.nombre} falló: ${msg}`);
      fallos.push(`${p.nombre}: ${msg}`);
    }
  }
  throw new Error("Todos los proveedores de IA fallaron | " + fallos.join(" | "));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { pregunta, clave_publicacion } = await req.json();
    if (!pregunta || typeof pregunta !== "string") {
      return new Response(JSON.stringify({ error: "Falta 'pregunta'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const preguntaSinAcentos = sinAcentos(pregunta.toLowerCase());

    if (
      preguntaSinAcentos.includes("aprendiste hoy") ||
      preguntaSinAcentos.includes("has aprendido hoy") ||
      preguntaSinAcentos.includes("aprendido el dia de hoy")
    ) {
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      const { data: deHoy } = await supabase
        .from("conocimiento")
        .select("pregunta, creado_en")
        .gte("creado_en", hoy.toISOString())
        .order("creado_en", { ascending: false });

      const resumen = deHoy && deHoy.length
        ? deHoy.map((p: any) => `\u2022 ${p.pregunta}`).join("\n")
        : "Hoy todavía no he aprendido nada nuevo. Pregúntame algo para empezar.";

      return new Response(
        JSON.stringify({ respuesta: `Esto es lo que aprendí hoy:\n${resumen}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const clave = pregunta.slice(0, 50).replace(/[%_]/g, "");
    const { data: previos } = await supabase
      .from("conocimiento")
      .select("pregunta, respuesta, creado_en")
      .or(`pregunta.ilike.%${clave}%,tema.ilike.%${clave}%`)
      .order("creado_en", { ascending: false })
      .limit(6);

    const contextoPrevio = (previos ?? [])
      .map((p: any) => `- Pregunta previa: ${p.pregunta}\n  Respuesta dada: ${p.respuesta}`)
      .join("\n");

    const busqueda = await buscarEnInternet(pregunta);

    const sistemaGenerador = `Eres el bot constructor personal de Jairo (Cerebro IA). Responde o construye EXACTAMENTE lo que pide, con la mayor precisión y calidad profesional posible.
Reglas de precisión:
- No inventes datos, cifras, nombres o hechos que no tengas respaldados; si algo no lo sabes con certeza, dilo explícitamente en vez de adivinar.
- Si te pide código o construir algo (página, script, texto), entrégalo completo y funcional, sin recortarlo ni dejar partes a medias, dentro de un bloque de código con ´´´.
- Sé específico y concreto, evita relleno genérico.
Si hay conocimiento previo relevante, úsalo como contexto, pero no lo repitas textualmente.
Si hay resultados de búsqueda en internet, úsalos para dar información más actualizada; si están vacíos o no vienen al caso, respalda tu respuesta en tu propio conocimiento y aclaralo.

Conocimiento previo relacionado:
${contextoPrevio || "(sin antecedentes todavía sobre este tema)"}

Resultados de búsqueda en internet (DuckDuckGo):
${busqueda.texto || "(sin resultados de búsqueda disponibles para esta consulta)"}`;

    const borrador = await llamarIA(sistemaGenerador, pregunta, 0.5);

    const sistemaRevisor = `Eres un revisor exigente y muy preciso. Te dan una petición original y un borrador de respuesta.
Corrige errores factuales, de código o de lógica, mejora claridad y precisión, elimina relleno genérico, y asegúrate de que cumple EXACTAMENTE lo pedido y está completo (sin cortar código ni texto a la mitad). Si el borrador trae código, conserva el bloque de código con ´´´.
Devuelve únicamente la versión final mejorada, sin comentarios sobre el proceso de revisión.`;

    const mensajeRevisor = `Petición original: ${pregunta}\n\nBorrador a revisar:\n${borrador.texto}`;

    // Si la revisión falla, se conserva el borrador en vez de perder todo el trabajo.
    let final = borrador.texto;
    let proveedorFinal = borrador.proveedor;
    let revisado = true;
    try {
      const rev = await llamarIA(sistemaRevisor, mensajeRevisor, 0.2);
      final = rev.texto;
      proveedorFinal = rev.proveedor;
    } catch (errRev) {
      revisado = false;
      console.error("La revisión falló, se usa el borrador:", String((errRev as any)?.message ?? errRev));
    }

    const fuentesBase = busqueda.fuentes.length
      ? busqueda.fuentes.join(", ")
      : "generado por IA (sin resultados de búsqueda para esta consulta)";
    const fuentesTexto = `${fuentesBase} | IA: ${proveedorFinal}${revisado ? "" : " (sin revisión)"}`;

    await supabase.from("conocimiento").insert({
      pregunta,
      respuesta: final,
      fuentes: fuentesTexto,
      tema: pregunta.slice(0, 60),
    });

    const quierePublicar = /\bpublic[ao]|\bsube(lo)?\s+a\s+github|\bsubelo\b/.test(preguntaSinAcentos);

    if (quierePublicar) {
      // Seguridad: publicar en GitHub solo con la clave interna (cabecera x-cerebro-clave o campo clave_publicacion).
      const claveRecibida = String(req.headers.get("x-cerebro-clave") ?? clave_publicacion ?? "");
      const { data: autorizado } = await supabase.rpc("verificar_clave_cerebro", { p: claveRecibida });
      if (autorizado !== true) {
        return new Response(
          JSON.stringify({ respuesta: `${final}\n\n\u26a0\ufe0f Publicación bloqueada: para publicar en GitHub se necesita la clave de autorización.` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const path = extraerNombreArchivo(pregunta, preguntaSinAcentos);
      try {
        const codigo = limpiarCodigo(final);
        const urlPublicada = await publicarEnGitHub(path, codigo, `Cerebro IA: ${pregunta.slice(0, 60)}`);
        return new Response(
          JSON.stringify({ respuesta: `${final}\n\n\u2705 Publicado en: ${urlPublicada}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (errPublicar) {
        return new Response(
          JSON.stringify({ respuesta: `${final}\n\n\u26a0\ufe0f No se pudo publicar: ${String((errPublicar as any)?.message ?? errPublicar)}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(JSON.stringify({ respuesta: final }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

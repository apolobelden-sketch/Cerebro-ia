import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await sb.rpc("verificar_clave_cerebro", { p: req.headers.get("x-cerebro-clave") ?? "" });
  if (ok !== true) return json({ error: "No autorizado" }, 401);

  const key = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
  if (!key) return json({ ok: false, error: "No existe GEMINI_API_KEY" });
  const body = await req.json().catch(() => ({}));

  let modelos: string[] = [];
  try {
    const lm = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20000) });
    const d = await lm.json().catch(() => null);
    modelos = (d?.models ?? []).map((m: any) => String(m.name).replace("models/", "")).filter((n: string) => /image|imagen/i.test(n));
  } catch (e) {
    return json({ ok: false, error: `No se pudo listar modelos: ${String((e as Error)?.message ?? e)}` });
  }

  const omitir: string[] = body?.omitir ?? [];
  const candidatos = modelos.filter((n) => !omitir.includes(n));
  const intentos: unknown[] = [];
  const prompt = "Children's coloring book page: a friendly cartoon dinosaur, thick clean black outlines, pure white background, no shading, no gray, no color, large open areas, no text.";
  for (const modelo of candidatos) {
    try {
      const esImagen = /^imagen/i.test(modelo);
      const url = esImagen
        ? `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:predict`
        : `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;
      const payload = esImagen
        ? { instances: [{ prompt }], parameters: { sampleCount: 1 } }
        : { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } };
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
      const d = await r.json().catch(() => null);
      let b64: string | null = null; let mime = "image/png";
      if (esImagen) { b64 = d?.predictions?.[0]?.bytesBase64Encoded ?? null; mime = d?.predictions?.[0]?.mimeType ?? mime; }
      else {
        const img = (d?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p?.inlineData?.data || p?.inline_data?.data);
        if (img) { const i = img.inlineData ?? img.inline_data; b64 = i.data; mime = i.mimeType ?? i.mime_type ?? mime; }
      }
      if (r.ok && b64) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const ruta = `pruebas/gemini-${modelo}.${mime.includes("jpeg") ? "jpg" : "png"}`;
        const { error } = await sb.storage.from("archivos").upload(ruta, bytes, { contentType: mime, upsert: true });
        const pub = error ? null : sb.storage.from("archivos").getPublicUrl(ruta).data.publicUrl;
        intentos.push({ modelo, ok: true, bytes: bytes.length, url: pub });
        break;
      }
      intentos.push({ modelo, ok: false, status: r.status, error: String(d?.error?.message ?? "sin imagen").slice(0, 200) });
    } catch (e) {
      intentos.push({ modelo, ok: false, error: String((e as Error)?.message ?? e).slice(0, 150) });
    }
  }
  return json({ ok: true, modelos_de_imagen_visibles: modelos, intentos });
});

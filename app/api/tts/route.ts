import { NextResponse } from "next/server";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// "Rachel" — clear, natural American female voice
// Other good free voices: "Bella" (EXAVITQu4vrVxn66xGMD), "Nicole" (piTKgcLEGmPE4e6mEKli), "Domi" (AZnzlk1XvdvUeBnXmlld)
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel

export async function POST(request: Request) {
  const { text } = await request.json();

  if (!ELEVENLABS_API_KEY) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY not configured" }, { status: 503 });
  }

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_turbo_v2_5", // fastest + most natural, low latency
      voice_settings: {
        stability: 0.45,        // lower = more expressive/human
        similarity_boost: 0.75, // how close to original voice
        style: 0.35,            // expressiveness
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: `ElevenLabs error: ${err}` }, { status: 500 });
  }

  const audioBuffer = await res.arrayBuffer();
  return new NextResponse(audioBuffer, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}

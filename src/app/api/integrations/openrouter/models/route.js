import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// This endpoint is protected by dashboardGuard as part of /api/integrations/*
// and is intended for service-to-service control-token access from OpenRussiaRouter.
export async function GET() {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenRussiaRouter-Node/1.0",
      },
      next: { revalidate: 300 },
    });

    if (!response.ok) {
      console.error(`[Integrations] OpenRouter upstream returned HTTP ${response.status}`);
      return NextResponse.json(
        { error: `OpenRouter upstream returned HTTP ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[Integrations] Failed to fetch OpenRouter models:", error);
    return NextResponse.json(
      { error: "Failed to fetch OpenRouter models from upstream" },
      { status: 502 }
    );
  }
}

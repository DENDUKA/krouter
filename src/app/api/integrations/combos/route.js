import { NextResponse } from "next/server";
import { getCombos } from "@/lib/localDb";

// This endpoint is protected by dashboardGuard as part of /api/integrations/*
// and is intended for service-to-service control-token access.
export async function GET() {
  try {
    return NextResponse.json({ combos: await getCombos() });
  } catch (error) {
    console.error("[Integrations] Failed to fetch combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

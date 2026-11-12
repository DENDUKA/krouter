import { NextResponse } from "next/server";
import { syncManagedApiKeys } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

// POST /api/integrations/keys/sync - bulk sync active keys
export async function POST(request) {
  try {
    const body = await request.json();
    
    if (!body || typeof body !== "object" || !Array.isArray(body.keys)) {
      console.info(
        `[Integrations][Keys] action=sync managedBy=openrussia-router result=rejected`
      );
      return NextResponse.json(
        { error: "Request body must contain a 'keys' array" },
        { status: 400 }
      );
    }

    const { keys } = body;
    const machineId = await getConsistentMachineId();
    
    const validKeys = [];
    for (const item of keys) {
      if (!item || typeof item !== "object") continue;
      
      const { name, key, isActive } = item;
      
      if (!name || typeof name !== "string" || name.trim() === "") continue;
      if (!key || typeof key !== "string" || key.length < 16 || key.length > 256 || !key.startsWith("sk-or-") || /\s/.test(key)) continue;
      
      validKeys.push({
        name,
        key,
        machineId,
        // Default to active when the field is omitted (back-compat with older callers).
        isActive: isActive === undefined ? true : Boolean(isActive),
        visibleInDashboard: true
      });
    }

    const result = await syncManagedApiKeys(validKeys);

    console.info(
      `[Integrations][Keys] action=sync managedBy=openrussia-router result=success added=${result.addedCount} disabled=${result.disabledCount} reactivated=${result.reactivatedCount} deleted=${result.deletedCount}`
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.info(
      `[Integrations][Keys] action=sync managedBy=openrussia-router result=error error=${error.message}`
    );
    return NextResponse.json(
      { error: "Failed to sync integration keys" },
      { status: 500 }
    );
  }
}

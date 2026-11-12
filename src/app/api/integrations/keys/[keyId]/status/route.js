import { NextResponse } from "next/server";
import { getApiKeyById, setApiKeyActive } from "@/lib/localDb";

export const dynamic = "force-dynamic";

function keyPreview(key) {
  if (!key || key.length <= 8) return key;
  return key.slice(0, 5) + "..." + key.slice(-4);
}

// PATCH /api/integrations/keys/{keyId}/status — enable/disable a service-managed key
export async function PATCH(request, { params }) {
  try {
    const { keyId } = await params;
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      console.info(
        `[Integrations][Keys] action=status keyId=${keyId} managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Request body must be a JSON object" },
        { status: 400 }
      );
    }

    const { isActive } = body;

    if (typeof isActive !== "boolean") {
      console.info(
        `[Integrations][Keys] action=status keyId=${keyId} managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "isActive must be a boolean" },
        { status: 400 }
      );
    }

    const existing = await getApiKeyById(keyId);
    if (!existing) {
      console.info(
        `[Integrations][Keys] action=status keyId=${keyId} managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    if (existing.managedBy !== "openrussia-router") {
      console.info(
        `[Integrations][Keys] action=status keyId=${keyId} managedBy=openrussia-router result=rejected isActive=${isActive}`
      );
      return NextResponse.json(
        { error: "Key is not managed by OpenRussiaRouter" },
        { status: 403 }
      );
    }

    const updated = await setApiKeyActive(keyId, isActive);

    console.info(
      `[Integrations][Keys] action=status keyId=${keyId} managedBy=openrussia-router result=updated isActive=${isActive}`
    );

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      keyPreview: keyPreview(updated.key),
      machineId: updated.machineId,
      isActive: updated.isActive,
      managedBy: updated.managedBy,
      createdAt: updated.createdAt,
    });
  } catch (error) {
    console.info(
      `[Integrations][Keys] action=status keyId=n/a managedBy=openrussia-router result=error isActive=n/a error=${error.message}`
    );
    return NextResponse.json(
      { error: "Failed to update key status" },
      { status: 500 }
    );
  }
}

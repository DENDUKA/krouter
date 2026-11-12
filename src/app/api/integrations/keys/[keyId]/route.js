import { NextResponse } from "next/server";
import { getApiKeyById, deleteApiKey } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// DELETE /api/integrations/keys/{keyId} — permanently remove a service-managed key
export async function DELETE(request, { params }) {
  try {
    const { keyId } = await params;

    const existing = await getApiKeyById(keyId);
    if (!existing) {
      console.info(
        `[Integrations][Keys] action=delete keyId=${keyId} managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    if (existing.managedBy !== "openrussia-router") {
      console.info(
        `[Integrations][Keys] action=delete keyId=${keyId} managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Key is not managed by OpenRussiaRouter" },
        { status: 403 }
      );
    }

    const deleted = await deleteApiKey(keyId);

    console.info(
      `[Integrations][Keys] action=delete keyId=${keyId} managedBy=openrussia-router result=${deleted ? "deleted" : "missing"} isActive=n/a`
    );

    return NextResponse.json({ deleted, id: keyId });
  } catch (error) {
    console.info(
      `[Integrations][Keys] action=delete keyId=n/a managedBy=openrussia-router result=error isActive=n/a error=${error.message}`
    );
    return NextResponse.json(
      { error: "Failed to delete integration key" },
      { status: 500 }
    );
  }
}

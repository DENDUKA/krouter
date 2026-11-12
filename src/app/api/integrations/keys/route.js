import { NextResponse } from "next/server";
import {
  createApiKeyWithValue,
  getApiKeyByValue,
  getManagedApiKeys,
} from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

function keyPreview(key) {
  if (!key || key.length <= 8) return key;
  return key.slice(0, 5) + "..." + key.slice(-4);
}

function isUniqueConstraintError(error) {
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || error?.cause?.message || "");
  return (
    code === "SQLITE_CONSTRAINT" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    /unique constraint/i.test(message) ||
    /constraint failed/i.test(message)
  );
}

function duplicateResponse(existing) {
  if (existing?.managedBy === "openrussia-router") {
    console.info(
      `[Integrations][Keys] action=create keyId=${existing.id} managedBy=openrussia-router result=exists isActive=${existing.isActive}`
    );
    return NextResponse.json({ created: false, id: existing.id });
  }

  if (existing) {
    console.info(
      `[Integrations][Keys] action=create keyId=${existing.id} managedBy=openrussia-router result=rejected isActive=n/a`
    );
    return NextResponse.json(
      { error: "Key already exists and is not managed by OpenRussiaRouter" },
      { status: 409 }
    );
  }

  return null;
}

// GET /api/integrations/keys — list service-managed keys (metadata + preview only)
export async function GET() {
  try {
    const keys = await getManagedApiKeys();
    const safe = keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPreview: keyPreview(k.key),
      machineId: k.machineId,
      isActive: k.isActive,
      managedBy: k.managedBy,
      createdAt: k.createdAt,
    }));
    return NextResponse.json({ keys: safe });
  } catch (error) {
    console.info(
      `[Integrations][Keys] action=list keyId=n/a managedBy=openrussia-router result=error isActive=n/a error=${error.message}`
    );
    return NextResponse.json(
      { error: "Failed to list integration keys" },
      { status: 500 }
    );
  }
}

// POST /api/integrations/keys — create a service-managed key with a given value
export async function POST(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      console.info(
        `[Integrations][Keys] action=create keyId=n/a managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Request body must be a JSON object" },
        { status: 400 }
      );
    }

    const { name, key } = body;

    // --- Validate name ---
    if (!name || typeof name !== "string" || name.trim() === "") {
      console.info(
        `[Integrations][Keys] action=create keyId=n/a managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Name is required and must be a non-empty string" },
        { status: 400 }
      );
    }

    // --- Validate key ---
    if (!key || typeof key !== "string") {
      console.info(
        `[Integrations][Keys] action=create keyId=n/a managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Key is required" },
        { status: 400 }
      );
    }
    if (key.length < 16 || key.length > 256) {
      console.info(
        `[Integrations][Keys] action=create keyId=n/a managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Key must be between 16 and 256 characters" },
        { status: 400 }
      );
    }
    if (!key.startsWith("sk-or-")) {
      console.info(
        `[Integrations][Keys] action=create keyId=n/a managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Key must start with sk-or-" },
        { status: 400 }
      );
    }
    if (/\s/.test(key)) {
      console.info(
        `[Integrations][Keys] action=create keyId=n/a managedBy=openrussia-router result=rejected isActive=n/a`
      );
      return NextResponse.json(
        { error: "Key must not contain whitespace" },
        { status: 400 }
      );
    }

    // --- Duplicate handling (idempotency) ---
    const existing = await getApiKeyByValue(key);
    if (existing) {
      return duplicateResponse(existing);
    }

    // --- Create ---
    const machineId = await getConsistentMachineId();
    let apiKey;
    try {
      apiKey = await createApiKeyWithValue({
        name,
        key,
        machineId,
        managedBy: "openrussia-router",
        visibleInDashboard: true,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const racedExisting = await getApiKeyByValue(key);
        const response = duplicateResponse(racedExisting);
        if (response) return response;
      }
      throw error;
    }

    console.info(
      `[Integrations][Keys] action=create keyId=${apiKey.id} managedBy=openrussia-router result=created isActive=true`
    );

    return NextResponse.json(
      { created: true, id: apiKey.id },
      { status: 201 }
    );
  } catch (error) {
    console.info(
      `[Integrations][Keys] action=create keyId=n/a managedBy=openrussia-router result=error isActive=n/a error=${error.message}`
    );
    return NextResponse.json(
      { error: "Failed to create integration key" },
      { status: 500 }
    );
  }
}

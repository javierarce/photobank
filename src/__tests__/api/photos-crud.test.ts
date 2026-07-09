import { describe, it, expect, vi, beforeEach } from "vitest";

const mockS3Send = vi.fn().mockResolvedValue({});
let mockPhoto: Record<string, unknown> | null = null;
// Result of the destination-conflict lookup in PATCH (second select call)
let mockOccupant: Record<string, unknown> | null = null;
let selectCall = 0;
const mockUpdatedPhoto = {
  id: "p1",
  filename: "renamed.jpg",
  folder: "new-folder",
  s3Key: "new-folder/renamed.jpg",
};

vi.mock("@/lib/s3", () => ({
  s3: { send: (...args: unknown[]) => Promise.resolve(mockS3Send(...args)) },
  S3_BUCKET: "test-bucket",
}));

const copySpy = vi.fn();
const deleteSpy = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  CopyObjectCommand: class {
    constructor(params: Record<string, unknown>) {
      copySpy(params);
      Object.assign(this, params);
    }
  },
  DeleteObjectCommand: class {
    constructor(params: Record<string, unknown>) {
      deleteSpy(params);
      Object.assign(this, params);
    }
  },
  ListObjectsV2Command: class {},
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          selectCall++;
          if (selectCall === 1) return mockPhoto ? [mockPhoto] : [];
          return mockOccupant ? [mockOccupant] : [];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => [mockUpdatedPhoto],
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  photos: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

const { NextRequest } = await import("next/server");
const { PATCH, DELETE } = await import("@/app/api/photos/[id]/route");

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockResolvedValue({});
  mockOccupant = null;
  selectCall = 0;
  mockPhoto = {
    id: "p1",
    filename: "beach.jpg",
    folder: "vacation",
    s3Key: "vacation/beach.jpg",
  };
});

describe("PATCH /api/photos/:id (move/rename)", () => {
  it("returns 404 when photo not found", async () => {
    mockPhoto = null;

    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "new-folder" }),
    });

    const res = await PATCH(req, {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns photo unchanged when no actual change", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "vacation", filename: "beach.jpg" }),
    });

    const res = await PATCH(req, {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(200);

    // No S3 operations should happen
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("copies original + all 8 variants to new location on move", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "new-folder" }),
    });

    await PATCH(req, { params: Promise.resolve({ id: "p1" }) });

    // 1 original copy + 8 variant copies + 1 original delete + 8 variant deletes = 18 S3 calls
    expect(mockS3Send).toHaveBeenCalledTimes(18);

    // Verify the original was copied
    expect(copySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "test-bucket",
        CopySource: "test-bucket/vacation/beach.jpg",
        Key: "new-folder/beach.jpg",
      })
    );
  });

  it("copies variants with correct suffixes", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "archive" }),
    });

    await PATCH(req, { params: Promise.resolve({ id: "p1" }) });

    const expectedSuffixes = [
      "_128.jpg",
      "_128.webp",
      "_640.jpg",
      "_640.webp",
      "_1280.jpg",
      "_1280.webp",
      "_2880.jpg",
      "_2880.webp",
    ];

    for (const suffix of expectedSuffixes) {
      expect(copySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          CopySource: `test-bucket/vacation/beach${suffix}`,
          Key: `archive/beach${suffix}`,
        })
      );
    }
  });

  it("deletes old original + variants after copy", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "archive" }),
    });

    await PATCH(req, { params: Promise.resolve({ id: "p1" }) });

    // Original delete
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: "test-bucket",
        Key: "vacation/beach.jpg",
      })
    );

    // Variant deletes
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ Key: "vacation/beach_640.webp" })
    );
  });

  it("handles rename (new filename, same folder)", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ filename: "sunset.jpg" }),
    });

    await PATCH(req, { params: Promise.resolve({ id: "p1" }) });

    expect(copySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        CopySource: "test-bucket/vacation/beach.jpg",
        Key: "vacation/sunset.jpg",
      })
    );
  });

  it("continues when variant copy fails (variant may not exist yet)", async () => {
    let callCount = 0;
    mockS3Send.mockImplementation(() => {
      callCount++;
      // Fail on 3rd call (a variant copy)
      if (callCount === 3) throw new Error("NoSuchKey");
      return {};
    });

    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "archive" }),
    });

    const res = await PATCH(req, {
      params: Promise.resolve({ id: "p1" }),
    });
    // Should still succeed
    expect(res.status).toBe(200);
  });

  it("returns 409 when another photo occupies the destination", async () => {
    mockOccupant = { id: "p2" };

    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "archive" }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(409);
    // Nothing in S3 should have been touched
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("allows a case-change rename where the occupant is the photo itself", async () => {
    mockOccupant = { id: "p1" };

    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ filename: "sunset.jpg" }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(200);
  });

  it("rejects folders containing path separators", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ folder: "a/b" }),
    });

    const res = await PATCH(req, { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(400);
  });

  it("rejects empty and traversal filenames", async () => {
    for (const filename of ["", "   ", "..", "../"]) {
      selectCall = 0;
      const req = new NextRequest("http://localhost/api/photos/p1", {
        method: "PATCH",
        body: JSON.stringify({ filename }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(400);
    }
  });

  it("strips directory components from filenames", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "PATCH",
      body: JSON.stringify({ filename: "nested/dir/sunset.jpg" }),
    });

    await PATCH(req, { params: Promise.resolve({ id: "p1" }) });

    expect(copySpy).toHaveBeenCalledWith(
      expect.objectContaining({ Key: "vacation/sunset.jpg" })
    );
  });
});

describe("DELETE /api/photos/:id", () => {
  it("returns 404 when photo not found", async () => {
    mockPhoto = null;

    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "DELETE",
    });

    const res = await DELETE(req, {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes original + all 8 variants from S3", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "DELETE",
    });

    const res = await DELETE(req, {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deleted).toBe(true);

    // 1 original + 8 variants = 9 S3 delete calls
    expect(mockS3Send).toHaveBeenCalledTimes(9);
  });

  it("deletes the correct S3 keys", async () => {
    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "DELETE",
    });

    await DELETE(req, { params: Promise.resolve({ id: "p1" }) });

    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ Key: "vacation/beach.jpg" })
    );
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ Key: "vacation/beach_128.jpg" })
    );
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ Key: "vacation/beach_2880.webp" })
    );
  });

  it("succeeds even if some S3 deletes fail", async () => {
    let callCount = 0;
    mockS3Send.mockImplementation(() => {
      callCount++;
      if (callCount === 2) return Promise.reject(new Error("S3 error"));
      return {};
    });

    const req = new NextRequest("http://localhost/api/photos/p1", {
      method: "DELETE",
    });

    const res = await DELETE(req, {
      params: Promise.resolve({ id: "p1" }),
    });
    expect(res.status).toBe(200);
  });
});

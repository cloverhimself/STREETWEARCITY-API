import { v2 as cloudinary } from "cloudinary";
import { env } from "./env";
import { HttpError } from "../utils/http-error";

if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

const CONFIGURED = !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

export function uploadProductImage(buffer: Buffer): Promise<{ url: string; publicId: string }> {
  if (!CONFIGURED) return Promise.reject(HttpError.internal("Cloudinary is not configured"));

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "streetwarecity/products", resource_type: "image" },
      (err, result) => {
        if (err || !result) return reject(err instanceof Error ? err : new Error("Cloudinary upload failed"));
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

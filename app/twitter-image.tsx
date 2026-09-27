// Same image as opengraph-image.tsx, exposed under the twitter-image file
// convention too — Twitter/X doesn't always fall back to og:image, and the
// root layout now sets `twitter.card = "summary_large_image"`, which wants
// its own twitter:image.
export { alt, size, contentType, runtime, default } from "./opengraph-image";

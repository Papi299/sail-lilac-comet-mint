import { createFileRoute } from "@tanstack/react-router";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export const Route = createFileRoute("/faq")({ component: FaqPage });

const FAQS = [
  {
    q: "How do I download a video?",
    a: "Paste the video URL, analyze it, select the desired quality, and click Download. When processing finishes, save the file to your device.",
  },
  {
    q: "Why isn't a website working?",
    a: "The website may use a delivery method that the current extractor does not support, or it may require a signed-in session. Direct media file links are the most reliable option.",
  },
  {
    q: "What formats are available?",
    a: "Available formats depend on the source. Common outputs include MP4, WebM, and audio-only formats. MP3 conversion is offered when media processing is available.",
  },
  {
    q: "How long are files stored?",
    a: "Generated files are temporary and automatically deleted after the configured expiration period, typically around 45 minutes.",
  },
  {
    q: "Why are video and audio processed separately?",
    a: "Some websites provide video and audio as separate streams. The application combines them automatically before offering the download.",
  },
  {
    q: "Can I download any video on the internet?",
    a: "Only download videos you have the right to save. Respect copyright and the terms of each website. VideoFetch does not bypass paid, private, or DRM-protected content.",
  },
];

function FaqPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="font-display text-4xl tracking-tight">FAQ</h1>
      <p className="mt-3 text-muted-foreground">Straightforward answers about how VideoFetch works.</p>
      <Accordion type="single" collapsible className="mt-8">
        {FAQS.map((item, index) => (
          <AccordionItem key={item.q} value={`item-${index}`}>
            <AccordionTrigger>{item.q}</AccordionTrigger>
            <AccordionContent>{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

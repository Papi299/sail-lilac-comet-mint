import { Card, CardContent } from "@/components/ui/card";

export function ErrorCard({
  heading,
  message,
  onReset,
}: {
  heading: string;
  message: string;
  onReset: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-5 sm:p-6">
        <h2 className="font-medium">{heading}</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
        <button
          type="button"
          className="text-sm underline-offset-4 hover:underline"
          onClick={onReset}
        >
          Start over
        </button>
      </CardContent>
    </Card>
  );
}

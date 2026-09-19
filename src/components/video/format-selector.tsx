import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SourceQualityNotice } from "@/components/video/source-quality-notice";
import {
  isAdvancedAvailable,
  presentSourceQuality,
  presetDisplayLabel,
  qualityOptions,
} from "@/lib/source-quality-ui";
import { formatBytes } from "@/lib/utils";
import type { VideoMetadata } from "@/types/media";

type Props = {
  video: VideoMetadata;
  simpleMode: boolean;
  onSimpleMode: (value: boolean) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  onDownload: () => void;
  downloading?: boolean;
};

export function FormatSelector({
  video,
  simpleMode,
  onSimpleMode,
  selectedId,
  onSelect,
  onDownload,
  downloading,
}: Props) {
  const selectedPreset = video.presets.find((p) => p.id === selectedId);
  const selectedFormat = video.formats.find((f) => f.id === selectedId);
  const size = selectedPreset?.fileSize ?? selectedFormat?.fileSize ?? null;
  const container = selectedPreset?.container ?? selectedFormat?.container ?? "mp4";
  const codec = selectedPreset?.videoCodec ?? selectedFormat?.videoCodec;
  const audio = selectedPreset?.audioCodec ?? selectedFormat?.audioCodec;
  const advancedGroups = useMemo(() => groupAdvanced(video), [video]);
  const options = useMemo(() => qualityOptions(video), [video]);
  const quality = useMemo(() => presentSourceQuality(video), [video]);
  // No raw format list means Advanced has nothing to show, whatever the switch
  // last said.
  const advancedAvailable = isAdvancedAvailable(video);
  const showSimple = simpleMode || !advancedAvailable;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Choose quality and format</p>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Advanced</span>
            <Switch
              checked={!showSimple}
              disabled={!advancedAvailable}
              className="disabled:cursor-not-allowed disabled:opacity-50"
              aria-describedby={advancedAvailable ? undefined : "advanced-unavailable"}
              onCheckedChange={(v) => onSimpleMode(!v)}
            />
          </label>
        </div>
        {advancedAvailable ? null : (
          <p id="advanced-unavailable" className="text-xs text-muted-foreground sm:text-right">
            Advanced unavailable for this source
          </p>
        )}
      </div>

      {showSimple ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="quality">Quality</Label>
            <Select value={selectedId} onValueChange={onSelect}>
              <SelectTrigger id="quality" className="w-full">
                <SelectValue placeholder="Select quality" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Format</Label>
            <div className="flex h-11 items-center rounded-lg border border-input bg-card px-3 text-sm">
              {container.toUpperCase()}
              {codec ? ` · ${codec}` : ""}
              {audio ? ` / ${audio}` : ""}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Label htmlFor="advanced">Source format</Label>
          <Select value={selectedId} onValueChange={onSelect}>
            <SelectTrigger id="advanced" className="w-full">
              <SelectValue placeholder="Select format" />
            </SelectTrigger>
            <SelectContent>
              {video.presets
                .filter((p) => p.id === "preset:best" || p.id === "preset:mp3")
                .map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {presetDisplayLabel(preset, video)}
                  </SelectItem>
                ))}
              {advancedGroups.map((group) =>
                group.formats.map((format) => (
                  <SelectItem key={format.id} value={format.id}>
                    {group.label} · {format.container.toUpperCase()}
                    {format.fps ? ` ${Math.round(format.fps)}fps` : ""}
                    {format.videoCodec ? ` · ${format.videoCodec}` : ""}
                    {format.audioCodec ? ` / ${format.audioCodec}` : ""}
                    {format.hasVideo && !format.hasAudio ? " · video only" : ""}
                    {format.fileSize ? ` · ${formatBytes(format.fileSize)}` : ""}
                  </SelectItem>
                )),
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      {quality?.notice ? <SourceQualityNotice notice={quality.notice} /> : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="text-sm text-muted-foreground">
          Estimated size: <span className="text-foreground">{formatBytes(size)}</span>
        </div>
        <Button className="w-full sm:w-auto" onClick={onDownload} disabled={downloading || !selectedId}>
          {downloading ? "Starting..." : "Download"}
        </Button>
      </div>
    </div>
  );
}

function groupAdvanced(video: VideoMetadata) {
  const order = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p", "audio", "unknown"];
  const groups: { label: string; formats: VideoMetadata["formats"] }[] = [];
  for (const key of order) {
    const formats = video.formats.filter((f) => f.resolution === key);
    if (formats.length) groups.push({ label: key === "audio" ? "Audio" : key, formats });
  }
  return groups;
}

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnChanges,
  signal,
  SimpleChanges,
  viewChild,
} from '@angular/core';
import { VideoPlayerControlsComponent } from '../../components/video-player/video-player-controls/video-player-controls.component';
import { VideoTileComponent } from '../../components/video-player/video-tile/video-tile.component';
import { ViewSettings } from '../../view-settings.model';
import { VideoPlayerState } from '../../components/video-player/video-player-state';
import { KeypointContainerComponent } from '../../components/keypoint-container/keypoint-container.component';
import { KeypointImpl } from '../../keypoint';
import { VideoWidget } from '../../video-widget';

import { CsvParserService } from '../../csv-parser.service';
import { ProjectInfoService } from '../../project-info.service';
import { SessionService } from '../../session.service';
import { LoadingService } from '../../loading.service';
import { Pair } from '../../utils/pair';
import { Session } from '../../session.model';
import { FineVideoService } from '../../utils/fine-video.service';
import * as dfd from 'danfojs';
import { PredictionFile } from '../../prediction-file';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ZoomableContentComponent } from '../../components/zoomable-content.component';
import { catchError, firstValueFrom, skipWhile } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ExtractedFramePredictionList } from '../../extract-frames-request';
import _ from 'lodash';

@Component({
  selector: 'app-viewer-center-panel',
  imports: [
    VideoPlayerControlsComponent,
    VideoTileComponent,
    KeypointContainerComponent,
    ZoomableContentComponent,
  ],
  templateUrl: './viewer-center-panel.component.html',
  styleUrl: './viewer-center-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ViewerCenterPanelComponent implements OnChanges {
  sessionKey = input<string | null>(null);

  // Size (px) of each video tile in the grid
  tileSizePx = input<number>(250);

  _loadedSessionKey = signal<string | null>(null);
  private csvParser = inject(CsvParserService);
  private httpClient = inject(HttpClient);
  private projectInfoService = inject(ProjectInfoService);
  private loadingService = inject(LoadingService);
  private fineVideoService = inject(FineVideoService);
  private loadSessionAbortController?: AbortController = undefined;

  get currentFrame() {
    return this.videoPlayerState.currentFrameSignal;
  }

  private viewSettings = inject(ViewSettings);
  videoPlayerState = inject(VideoPlayerState);

  protected widgetModels = signal([] as VideoWidget[]);
  // cached prediction files for this session.
  private predictionFiles = new Map<PredictionFile, dfd.DataFrame>();
  // cached metric files per prediction file: inner map key is metric name
  private metricFiles = new Map<PredictionFile, Map<string, dfd.DataFrame>>();

  /** Per-frame aggregated metrics for timeline display and navigation. */
  frameMetrics = signal<FrameMetrics | null>(null);

  // ── Confidence timeline ──

  protected timelineCanvas =
    viewChild<ElementRef<HTMLCanvasElement>>('timelineCanvas');
  confidenceThreshold = signal(0.9);

  protected timelineRows = computed(() => {
    const m = this.frameMetrics();
    if (!m) return [];
    const rows: TimelineRow[] = [
      { key: 'likelihood', label: 'likelihood', color: '#ef4444', data: m.likelihood },
    ];
    if (m.temporalNorm) {
      rows.push({ key: 'temporal_norm', label: 'temporal', color: '#f97316', data: m.temporalNorm });
    }
    if (m.pcaError) {
      rows.push({ key: 'pca_error', label: 'pca error', color: '#a855f7', data: m.pcaError });
    }
    return rows;
  });

  protected onTimelineClick(event: MouseEvent) {
    const canvas = this.timelineCanvas()?.nativeElement;
    const metrics = this.frameMetrics();
    if (!canvas || !metrics) return;

    const rect = canvas.getBoundingClientRect();
    const LABEL_WIDTH = 60;
    const clickX = event.clientX - rect.left - LABEL_WIDTH;
    const barWidth = rect.width - LABEL_WIDTH;
    if (clickX < 0 || barWidth <= 0) return;

    const fraction = clickX / barWidth;
    const frame = Math.round(fraction * (metrics.likelihood.length - 1));
    const fps = this.videoPlayerState.fps();
    this.videoPlayerState.currentTime.next(frame / fps);
  }

  protected onThresholdChange(event: Event) {
    const val = parseFloat((event.target as HTMLInputElement).value);
    if (!isNaN(val)) this.confidenceThreshold.set(val);
  }

  navigateToLowConfidence(direction: 1 | -1) {
    const metrics = this.frameMetrics();
    if (!metrics) return;

    const currentFrame = this.videoPlayerState.currentFrameSignal();
    const threshold = this.confidenceThreshold();
    const numFrames = metrics.likelihood.length;

    const isBadFrame = (f: number): boolean => {
      if (metrics.likelihood[f] < threshold) return true;
      if (metrics.temporalNorm && metrics.temporalNorm[f] > metrics.temporalNormP99) return true;
      if (metrics.pcaError && metrics.pcaError[f] > metrics.pcaErrorP99) return true;
      return false;
    };

    for (let i = 1; i < numFrames; i++) {
      const f = (currentFrame + direction * i + numFrames) % numFrames;
      if (isBadFrame(f)) {
        const fps = this.videoPlayerState.fps();
        this.videoPlayerState.currentTime.next(f / fps);
        return;
      }
    }
  }

  private drawConfidenceTimeline(
    canvas: HTMLCanvasElement,
    rows: TimelineRow[],
    metrics: FrameMetrics,
    currentFrame: number,
    threshold: number,
  ) {
    const ROW_HEIGHT = 16;
    const LABEL_WIDTH = 60;
    const rowCount = rows.length;
    const totalHeight = rowCount * ROW_HEIGHT;
    const totalWidth = canvas.clientWidth;

    canvas.width = totalWidth * window.devicePixelRatio;
    canvas.height = totalHeight * window.devicePixelRatio;
    canvas.style.height = totalHeight + 'px';

    const ctx = canvas.getContext('2d')!;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    ctx.clearRect(0, 0, totalWidth, totalHeight);

    const barWidth = totalWidth - LABEL_WIDTH;
    const numFrames = metrics.likelihood.length;
    if (numFrames === 0) return;

    for (let r = 0; r < rowCount; r++) {
      const row = rows[r];
      const y = r * ROW_HEIGHT;

      ctx.fillStyle = '#a0a0a0';
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.label, 2, y + ROW_HEIGHT / 2);

      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(LABEL_WIDTH, y, barWidth, ROW_HEIGHT);

      let rowThreshold: number;
      if (row.key === 'likelihood') {
        rowThreshold = threshold;
      } else if (row.key === 'temporal_norm') {
        rowThreshold = metrics.temporalNormP99;
      } else {
        rowThreshold = metrics.pcaErrorP99;
      }

      const data = row.data;
      for (let f = 0; f < numFrames; f++) {
        const val = data[f];
        const isBad = row.key === 'likelihood'
          ? val < rowThreshold
          : val > rowThreshold;
        if (isBad) {
          const x = LABEL_WIDTH + (f / numFrames) * barWidth;
          const w = Math.max(1, barWidth / numFrames);
          ctx.fillStyle = row.color;
          ctx.fillRect(x, y, w, ROW_HEIGHT);
        }
      }
    }

    const frameX = LABEL_WIDTH + (currentFrame / numFrames) * barWidth;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.fillRect(frameX - 0.5, 0, 1, totalHeight);
  }

  private buildKeypoint(
    keypointName: string,
    predictions: dfd.DataFrame,
    modelKey: string,
  ): KeypointImpl {
    return {
      id: keypointName + modelKey,
      name: keypointName,
      hoverText: keypointName,
      colorClass: computed(() => {
        const mi = this.viewSettings.modelsShown().indexOf(modelKey);
        if (mi == 0) return 'bg-red-400'; ///50';
        if (mi == 1) return 'bg-green-400'; ///50';
        return 'bg-sky-100'; ///50';
      }),
      modelKey,
      position: computed(() => {
        const i = Math.min(
          Math.max(this.currentFrame(), 0),
          predictions.index.length - 1,
        );
        const x = predictions.at(
          i.toString(),
          new Pair(keypointName, 'x').toMapKey(),
        ) as number;
        const y = predictions.at(
          i.toString(),
          new Pair(keypointName, 'y').toMapKey(),
        ) as number;
        return { x, y };
      }),
    };
  }

  private sessionService = inject(SessionService);

  private getVideoPathForFFProbe(sessionKey: string, view: string): string {
    const dataDir = this.projectInfoService.projectInfo?.data_dir as string;

    return dataDir + '/' + sessionKey.replace(/\*/g, view);
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['sessionKey']) {
      this.loadSessionAbort(this.sessionKey()!);
    }
  }

  private async loadSessionAbort(sessionKey: string | null) {
    if (this.loadSessionAbortController) {
      this.loadSessionAbortController.abort();
    }
    this.loadSessionAbortController = new AbortController();
    await this.loadSession(sessionKey, this.loadSessionAbortController.signal);
  }

  private async loadSession(
    sessionKey: string | null,
    abortSignal: AbortSignal,
  ) {
    if (sessionKey == null) {
      this.viewSettings.setModelOptions([]);
      this.predictionFiles = new Map();
      this.metricFiles = new Map();
      this.frameMetrics.set(null);
      this.videoPlayerState.reset();
      this.videoPlayerState.duration.set(0);
      this.videoPlayerState.fps.set(30);
      this._loadedSessionKey.set(sessionKey);
      this.widgetModels.set([]);
      return;
    }
    this.loadingService.isLoading.set(true);
    this.loadingService.progress.set(0);

    const sessionChanged = sessionKey != this._loadedSessionKey();

    // Wait for sessions to load if they're currently still loading.
    await firstValueFrom(
      this.sessionService.allSessions$.pipe(
        skipWhile(() => this.sessionService.sessionsLoading()),
      ),
    );
    try {
      const session = this.sessionService
        .allSessions()
        .find((session) => session.key === sessionKey);
      if (!session) {
        throw new Error(
          `Session not found: {sessionKey} in ${this.sessionService.allSessions()}`,
        );
      }

      // ##################################
      // Prepare by fetching relevant data.
      // TODO: pass abort signal into the fetch functions to make them cancel when needed.
      // ##################################
      const promises = [];
      const predictionFileCache = sessionChanged
        ? new Map<PredictionFile, dfd.DataFrame>()
        : this.predictionFiles;
      const metricFileCache = sessionChanged
        ? new Map<PredictionFile, Map<string, dfd.DataFrame>>()
        : this.metricFiles;
      let ffprobeData = null;
      if (sessionChanged) {
        promises.push(
          this.loadFFProbeMetadata(session).then((data) => {
            ffprobeData = data;
          }),
        );
      }
      promises.push(this.fetchDataFiles(session, predictionFileCache, metricFileCache));
      await Promise.all(promises);

      const newWidgetModels = this.pureComputeWidgetModels(
        session,
        predictionFileCache,
      );

      const availableModels = Array.from(
        new Set([
          ...this.sessionService
            .getPredictionFilesForSession(sessionKey)
            .map((pf) => pf.modelKey),
        ]),
      );

      // ##################################
      // Commit changes (only happens if everything above was successful.
      // ##################################
      if (abortSignal.aborted) {
        return;
      }
      this.viewSettings.setModelOptions(availableModels);
      this.predictionFiles = predictionFileCache;
      this.metricFiles = metricFileCache;
      if (sessionChanged) {
        this.videoPlayerState.reset();
        this.videoPlayerState.duration.set(ffprobeData!.duration);
        this.videoPlayerState.fps.set(ffprobeData!.fps);

        this._loadedSessionKey.set(sessionKey);
      }
      this.widgetModels.set(newWidgetModels);
      this.frameMetrics.set(this.computeFrameMetrics(predictionFileCache, metricFileCache));
    } finally {
      this.loadingService.isLoading.set(false);
    }
  }

  private pureComputeNecessaryPredictionFiles(sessionKey: string) {
    const viewSettings = this.viewSettings;
    if (!sessionKey) return [];

    const predictionFiles =
      this.sessionService.getPredictionFilesForSession(sessionKey);
    const necessaryPredictionFiles = predictionFiles.filter((pf) => {
      return (
        viewSettings.modelsShown().includes(pf.modelKey) &&
        viewSettings.viewsShown().includes(pf.viewName)
      );
    });
    return necessaryPredictionFiles;
  }
  private pureComputeWidgetModels(
    session: Session,
    predictionFileCache: Map<PredictionFile, dfd.DataFrame>,
  ): VideoWidget[] {
    const viewSettings = this.viewSettings;
    return viewSettings
      .viewsShown()
      .map((view): VideoWidget | null => {
        const sessionView = session.views.find((sv) => sv.viewName == view);
        if (!sessionView) return null;

        const pfiles = Array.from(predictionFileCache.keys()).filter(
          (pfile) =>
            pfile.viewName == view &&
            viewSettings.modelsShown().includes(pfile.modelKey),
        );
        return {
          id: view,
          videoSrc: this.fineVideoService.fineVideoPath(sessionView.videoPath),
          keypoints: signal(
            pfiles.flatMap((pf) => {
              return this.viewSettings.keypointsShown().map((keypoint) => {
                return this.buildKeypoint(
                  keypoint,
                  predictionFileCache.get(pf) as dfd.DataFrame,
                  pf.modelKey,
                );
              });
            }),
          ),
        };
      })
      .filter((item) => item != null);
  }

  private async loadFFProbeMetadata(session: Session) {
    return await this.sessionService.ffprobe(
      this.getVideoPathForFFProbe(
        session.relativePath,
        session.views[0].viewName,
      ),
    );
  }
  private async fetchDataFiles(
    session: Session,
    predictionFileCache: Map<PredictionFile, dfd.DataFrame>,
    metricFileCache: Map<PredictionFile, Map<string, dfd.DataFrame>>,
  ) {
    const necessaryPredictionFiles = this.pureComputeNecessaryPredictionFiles(
      session.key,
    );
    const metricSuffixes = ['temporal_norm', 'pca_singleview_error'];
    const promises = necessaryPredictionFiles.map(async (pf) => {
      if (this.predictionFiles.has(pf)) {
        // Reuse cached metric files too.
        if (this.metricFiles.has(pf)) {
          metricFileCache.set(pf, this.metricFiles.get(pf)!);
        }
        return Promise.resolve(predictionFileCache.get(pf));
      }
      const rawText = await this.sessionService.getPredictionFile(pf);
      if (rawText == null) {
        throw new Error('Prediction file not found');
      }
      const df = this.csvParser.parsePredictionFile(rawText);
      predictionFileCache.set(pf, df);

      // Fetch companion metric CSVs in parallel (optional, 404 → null).
      const modelDir = this.projectInfoService.projectInfo?.model_dir as string;
      const metricsMap = new Map<string, dfd.DataFrame>();
      const metricPromises = metricSuffixes.map(async (suffix) => {
        const metricPath = pf.path.replace(/\.csv$/, `_${suffix}.csv`);
        const src = '/app/v0/files/' + modelDir + '/' + metricPath;
        const metricText = await firstValueFrom(
          this.httpClient.get(src, { responseType: 'text' }).pipe(
            catchError(() => [null]),
          ),
        );
        if (metricText) {
          const mdf = this.csvParser.parseSimpleMetricFile(metricText);
          if (mdf.columns.length > 0) {
            metricsMap.set(suffix, mdf);
          }
        }
      });
      await Promise.all(metricPromises);
      if (metricsMap.size > 0) {
        metricFileCache.set(pf, metricsMap);
      }

      return df;
    });
    return Promise.all(promises);
  }

  onWidgetCloseClick(w: VideoWidget) {
    const nextViewsShown = this.viewSettings
      .viewsShown()
      .filter((v) => v != w.id);
    this.viewSettings.setViewsShown(nextViewsShown);
  }

  constructor() {
    this.viewSettings.viewsShown$.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this._loadedSessionKey() == null) return;
      // Reload session.
      this.loadSessionAbort(this._loadedSessionKey() as string);
    });
    this.viewSettings.keypointsShown$
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this._loadedSessionKey() == null) return;
        // Reload session.
        this.loadSessionAbort(this._loadedSessionKey() as string);
      });
    this.viewSettings.modelsShown$.pipe(takeUntilDestroyed()).subscribe(() => {
      if (this._loadedSessionKey() == null) return;
      // Reload session.
      this.loadSessionAbort(this._loadedSessionKey() as string);
    });

    // Re-draw timeline whenever data, frame, or threshold changes.
    effect(() => {
      const rows = this.timelineRows();
      const metrics = this.frameMetrics();
      const currentFrame = this.videoPlayerState.currentFrameSignal();
      const threshold = this.confidenceThreshold();
      const canvasEl = this.timelineCanvas()?.nativeElement;
      if (!canvasEl || rows.length === 0 || !metrics) return;
      this.drawConfidenceTimeline(canvasEl, rows, metrics, currentFrame, threshold);
    });
  }

  getPredictionsForFrameExtraction(
    modelKey: string,
  ): Record<string, ExtractedFramePredictionList> {
    const pf = Array.from(this.predictionFiles.keys()).filter(
      (key) =>
        key.modelKey === modelKey && key.sessionKey === this.sessionKey(),
    );

    const predictionLists: ExtractedFramePredictionList[] = pf.map(
      (predFile) => {
        const df = this.predictionFiles.get(predFile)!;
        const frameIndex = this.currentFrame();

        const keypoints = _.keys(
          _.keyBy(df.columns, (col) => Pair.fromMapKey(col).first),
        );
        return {
          model_name: modelKey,
          date_time: Date.now(),
          view_name: predFile.viewName,
          predictions: keypoints.map((keypoint) => {
            const x = df.at(
              frameIndex.toString(),
              new Pair(keypoint, 'x').toMapKey(),
            ) as number;
            const y = df.at(
              frameIndex.toString(),
              new Pair(keypoint, 'y').toMapKey(),
            ) as number;

            return {
              keypoint_name: keypoint,
              x: x,
              y: y,
            };
          }),
        };
      },
    );
    return _.keyBy(predictionLists, 'view_name');
  }

  private computeFrameMetrics(
    predictionFileCache: Map<PredictionFile, dfd.DataFrame>,
    metricFileCache: Map<PredictionFile, Map<string, dfd.DataFrame>>,
  ): FrameMetrics | null {
    // Determine frame count from the first prediction DataFrame.
    const firstDf = predictionFileCache.values().next().value as dfd.DataFrame | undefined;
    if (!firstDf || firstDf.index.length === 0) return null;
    const numFrames = firstDf.index.length;

    // Likelihood: median across all visible keypoints & views per frame.
    const likelihood = new Float32Array(numFrames).fill(NaN);
    const keypointsShown = this.viewSettings.keypointsShown();

    // Collect all likelihood columns across views using fast column access.
    const likelihoodCols: number[][] = [];
    for (const df of predictionFileCache.values()) {
      for (const kp of keypointsShown) {
        const colKey = new Pair(kp, 'likelihood').toMapKey();
        if (!df.columns.includes(colKey)) continue;
        likelihoodCols.push(df.column(colKey).values as number[]);
      }
    }
    for (let f = 0; f < numFrames; f++) {
      const vals = likelihoodCols
        .map((c) => c[f])
        .filter((v) => !isNaN(v));
      likelihood[f] = vals.length > 0 ? median(vals) : 1;
    }

    // Helper to aggregate a metric type: median across keypoints per frame.
    const aggregateMetric = (metricName: string): Float32Array | null => {
      // Collect all column arrays for this metric across views.
      const allCols: number[][] = [];

      for (const metricsMap of metricFileCache.values()) {
        const mdf = metricsMap.get(metricName);
        if (!mdf || mdf.columns.length === 0) continue;
        const cols = mdf.columns.filter((c) => keypointsShown.includes(c));
        if (cols.length === 0) continue;
        const mdfRows = mdf.shape[0];
        for (const col of cols) {
          const colValues = mdf.column(col).values as number[];
          allCols.push(colValues.slice(0, Math.min(numFrames, mdfRows)));
        }
      }
      if (allCols.length === 0) return null;

      const arr = new Float32Array(numFrames).fill(0);
      for (let f = 0; f < numFrames; f++) {
        const vals = allCols
          .filter((c) => f < c.length)
          .map((c) => c[f])
          .filter((v) => !isNaN(v));
        arr[f] = vals.length > 0 ? median(vals) : 0;
      }
      return arr;
    };

    const temporalNorm = aggregateMetric('temporal_norm');
    const pcaError = aggregateMetric('pca_singleview_error');

    return {
      likelihood,
      temporalNorm,
      temporalNormP99: temporalNorm ? percentile(temporalNorm, 99) : 0,
      pcaError,
      pcaErrorP99: pcaError ? percentile(pcaError, 99) : 0,
    };
  }
}

export interface FrameMetrics {
  likelihood: Float32Array;
  temporalNorm: Float32Array | null;
  temporalNormP99: number;
  pcaError: Float32Array | null;
  pcaErrorP99: number;
}

interface TimelineRow {
  key: string;
  label: string;
  color: string;
  data: Float32Array;
}

function median(vals: number[]): number {
  const sorted = vals.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr: Float32Array, p: number): number {
  const sorted = Array.from(arr).filter((v) => !isNaN(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

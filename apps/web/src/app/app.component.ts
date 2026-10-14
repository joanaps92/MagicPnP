import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { buildPagePlan, matchLocalAssetFiles, type ImportProject, type PrintSettings } from '@magicpnp/core';

interface ProjectView {
  id: string;
  imported: ImportProject;
  settings: PrintSettings;
  customBackAvailable: boolean;
  assetStatus: Record<string, { state: string; error?: string; mime?: string; widthPx?: number; heightPx?: number }>;
}

interface ApiError { error?: string }
interface LocalImageOption { fileIndex: number; label: string; sizeMiB: number }
interface ManualImageAssignment { assetKey: string; assetName: string; fileIndex: number | null; error?: string }

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="app-shell">
      <header class="topbar">
        <a class="brand" href="#inicio" aria-label="MagicPnP, inicio">
          <span class="brand-mark" aria-hidden="true">M</span>
          <span>MagicPnP</span>
        </a>
        <span class="top-note">Herramienta local para preparar tu baraja</span>
      </header>

      <section id="inicio" class="hero">
        <div class="hero-copy">
          <p class="eyebrow">DE MPC FILL A PAPEL</p>
          <h1>Prepara tus cartas<br><em>para imprimir.</em></h1>
          <p class="lede">Importa el XML, revisa los artes y genera un PDF A4 con nueve cartas por hoja.</p>
        </div>
        @if (!project()) {
          <div class="import-card" [class.dragging]="dragging()" (dragover)="onDragOver($event)" (dragleave)="onDragLeave($event)" (drop)="onDrop($event)">
            <div class="upload-icon" aria-hidden="true">↥</div>
            <h2>Empieza con tu pedido MPC Fill</h2>
            <p>Suelta aquí el archivo XML o selecciónalo desde tu dispositivo.</p>
            <label class="button primary upload-button">
              <input type="file" accept=".xml,application/xml,text/xml" (change)="importFile($event)">
              Elegir archivo XML
            </label>
            <span class="small-note">El XML se conserva solo en esta sesión temporal.</span>
          </div>
        } @else {
          <div class="summary-card">
            <div class="summary-head">
              <span class="status-dot"></span>
              <span>Pedido importado</span>
              <button class="quiet-button" (click)="closeProject()" [disabled]="busy()">Cerrar</button>
            </div>
            <div class="summary-stats">
              <div><strong>{{ project()!.imported.cards.length }}</strong><span>posiciones</span></div>
              <div><strong>{{ uniqueArtCount() }}</strong><span>artes referenciados</span></div>
              <div><strong>{{ pageCount() }}</strong><span>páginas PDF</span></div>
            </div>
            <p class="small-note">Las imágenes temporales se borran al cerrar el proyecto o al caducar la sesión.</p>
          </div>
        }
      </section>

      @if (error()) {
        <div class="notice error" role="alert"><span aria-hidden="true">!</span><span>{{ error() }}</span><button aria-label="Cerrar aviso" (click)="error.set('')">×</button></div>
      }
      @if (notice()) {
        <div class="notice success" role="status"><span aria-hidden="true">✓</span><span>{{ notice() }}</span><button aria-label="Cerrar aviso" (click)="notice.set('')">×</button></div>
      }
      @if (busy() && !isExporting()) {
        <div class="busy-line" role="status"><span class="spinner"></span>{{ busyLabel() }}</div>
      }

      @if (project(); as active) {
        <section class="workspace-section">
          <div class="section-heading">
            <div><p class="eyebrow">01 · REVISIÓN</p><h2>Orden y artes</h2></div>
            <div class="review-actions">
              <label class="button secondary file-button" [class.disabled-control]="busy()">
                Elegir carpeta de imágenes
                <input type="file" webkitdirectory multiple accept="image/jpeg,image/png,image/webp" [disabled]="busy()" (change)="importImageFolder($event)">
              </label>
              @if (downloading()) { <button class="button secondary" (click)="cancelDownloads()">Cancelar descargas</button> }
              @else { <button class="button secondary" (click)="downloadImages()" [disabled]="busy()">Intentar descargas de Drive</button> }
            </div>
          </div>
          @if (active.imported.warnings.length) {
            <div class="warning-box">
              <strong>Revisa estas observaciones</strong>
              <ul>@for (warning of active.imported.warnings; track $index) { <li>{{ warning }}</li> }</ul>
            </div>
          }
          <p class="section-intro">La numeración conserva el slot del XML. Si ya bajaste el lote con MPC Autofill, elige la carpeta donde quedaron las imágenes: MagicPnP las asociará por ID o nombre y subirá solo las coincidentes a esta sesión.</p>
          @if (manualAssignments().length) {
            <section class="manual-match-panel" aria-label="Asignación manual de imágenes ambiguas">
              <div class="manual-match-heading">
                <div><p class="eyebrow">ASIGNACIÓN MANUAL</p><h3>Resuelve las referencias ambiguas</h3></div>
                <span>{{ selectedManualAssignmentCount() }} seleccionadas</span>
              </div>
              <p class="manual-match-help">Elige el archivo de la carpeta que corresponde a cada arte. Se subirá al proyecto al pulsar el botón.</p>
              <div class="manual-match-list">
                @for (assignment of manualAssignments(); track assignment.assetKey) {
                  <div class="manual-match-item">
                    <label class="manual-match-row">
                      <span class="manual-match-asset"><strong>{{ assignment.assetName }}</strong><small>{{ assignment.assetKey }}</small></span>
                      <select [value]="assignment.fileIndex ?? ''" (change)="selectManualFile(assignment.assetKey, $event)" [disabled]="busy()">
                        <option value="">Elige el archivo de imagen…</option>
                        @for (option of manualImageOptions(); track option.fileIndex) {
                          <option [value]="option.fileIndex">{{ option.label }} · {{ option.sizeMiB | number:'1.1-1' }} MiB</option>
                        }
                      </select>
                    </label>
                    @if (assignment.error) { <small class="manual-match-error">{{ assignment.error }}</small> }
                  </div>
                }
              </div>
              <div class="manual-match-actions">
                <span>{{ manualAssignments().length }} referencias todavía necesitan una imagen.</span>
                <button class="button primary" (click)="uploadManualAssignments()" [disabled]="busy() || !selectedManualAssignmentCount()">Subir {{ selectedManualAssignmentCount() }} asignaciones</button>
              </div>
            </section>
          }
          <div class="card-list">
            @for (card of active.imported.cards; track card.slotIndex) {
              <article class="card-row">
                <div class="card-number">{{ card.slotIndex + 1 | number:'2.0' }}</div>
                <div class="art-column">
                  <div class="art-thumb">
                    @if (card.frontAssetKey && previewUrls()[card.frontAssetKey]) { <img [src]="previewUrls()[card.frontAssetKey]" alt="Anverso: {{ card.name }}"> }
                    @else { <span class="placeholder">{{ card.frontAssetKey ? 'Anverso pendiente' : 'Hueco conservado' }}</span> }
                  </div>
                  <div class="art-caption"><strong>{{ card.name }}</strong><small>{{ ppi(card.frontAssetKey, active) }}{{ ppi(card.frontAssetKey, active) ? ' ppp' : 'Sin arte' }}</small></div>
                  @if (card.frontAssetKey) {
                    <label class="file-link">Sustituir anverso<input type="file" accept="image/jpeg,image/png,image/webp" (change)="replaceAsset(card.frontAssetKey, $event)"></label>
                    @if (canRetry(card.frontAssetKey, active)) { <button class="text-button retry-button" (click)="retryAsset(card.frontAssetKey)">Reintentar descarga</button> }
                    @if (assetError(card.frontAssetKey, active)) { <small class="asset-error">{{ assetError(card.frontAssetKey, active) }}</small> }
                  }
                </div>
                <div class="art-column back-column">
                  <div class="art-thumb back-thumb">
                    @if (card.backAssetKey && previewUrls()[card.backAssetKey]) { <img [src]="previewUrls()[card.backAssetKey]" alt="Reverso de {{ card.name }}"> }
                    @else { <span class="placeholder">{{ card.backAssetKey ? 'Reverso pendiente' : 'Sin reverso' }}</span> }
                  </div>
                  <div class="art-caption"><strong>{{ card.isDoubleFacedOrCustomBack ? 'Reverso específico' : 'Reverso' }}</strong><small>{{ ppi(card.backAssetKey, active) }}{{ ppi(card.backAssetKey, active) ? ' ppp' : 'Sin arte' }}</small></div>
                  @if (card.backAssetKey) {
                    <label class="file-link">Sustituir reverso<input type="file" accept="image/jpeg,image/png,image/webp" (change)="replaceAsset(card.backAssetKey, $event)"></label>
                    @if (canRetry(card.backAssetKey, active)) { <button class="text-button retry-button" (click)="retryAsset(card.backAssetKey)">Reintentar descarga</button> }
                    @if (assetError(card.backAssetKey, active)) { <small class="asset-error">{{ assetError(card.backAssetKey, active) }}</small> }
                  }
                </div>
              </article>
            }
          </div>
          <div class="custom-back-row">
            <div><strong>Reverso común</strong><p>El archivo personalizado se aplica a slots sin reverso específico.</p></div>
            <select class="back-mode-select" [value]="active.settings.backMode" (change)="setBackMode($event)" aria-label="Elegir reverso común"><option value="xml">Usar reverso del XML</option><option value="custom" [disabled]="!active.customBackAvailable">Usar reverso personalizado</option></select>
            <label class="button secondary file-button">Subir reverso<input type="file" accept="image/jpeg,image/png,image/webp" (change)="replaceCommonBack($event)"></label>
          </div>
        </section>

        <section class="workspace-section print-section">
          <div class="section-heading">
            <div><p class="eyebrow">02 · IMPRESIÓN</p><h2>Perfil A4 · nueve cartas</h2></div>
            <span class="profile-chip"><span class="check-mark">✓</span> 63 × 88 mm</span>
          </div>
          <div class="settings-grid">
            <label class="setting-card"><span class="setting-icon">✳</span><span><strong>Sangrado</strong><small>La ficha de Soriano recomienda al menos 2 mm.</small></span><select [value]="active.settings.bleedMm" (change)="setBleed($event)"><option value="3">3 mm · recomendado</option><option value="2">2 mm</option><option value="0">0 mm · sin sangrado</option></select></label>
            <label class="setting-card"><span class="setting-icon">⌗</span><span><strong>Marcas de corte</strong><small>Se colocan fuera del rectángulo de corte.</small></span><input type="checkbox" [checked]="active.settings.cutMarks" (change)="setCutMarks($event)"></label>
            <label class="setting-card"><span class="setting-icon">↔</span><span><strong>Espejo del reverso</strong><small>Comprueba una hoja de prueba con la imprenta.</small></span><select [value]="active.settings.duplexMirror" (change)="setMirror($event)"><option value="none">Ninguno · sin verificar</option><option value="horizontal">Horizontal · volteo lado largo</option><option value="vertical">Vertical · volteo lado corto</option></select></label>
            <label class="setting-card"><span class="setting-icon">▧</span><span><strong>El arte ya tiene sangrado</strong><small>Si no, extiendo píxeles del borde; no crea sangrado artístico.</small></span><select [value]="active.settings.sourceIncludesBleed" (change)="setSourceBleed($event)"><option value="false">No · extender el borde</option><option value="true">Sí · incluir el sangrado del arte</option></select></label>
          </div>
          @if (active.settings.bleedMm === 0) { <p class="inline-warning">Sin sangrado, las marcas pueden acercarse al arte. Revisa la prueba con Soriano.</p> }
        </section>

        <section class="workspace-section preview-section">
          <div class="section-heading">
            <div><p class="eyebrow">03 · PREVISUALIZACIÓN</p><h2>Revisa el pliego</h2></div>
            <div class="page-switcher"><button aria-label="Página anterior" (click)="changePage(-1)" [disabled]="pageIndex() === 0">←</button><span>{{ pageIndex() + 1 }} <small>/ {{ pageCount() }}</small></span><button aria-label="Página siguiente" (click)="changePage(1)" [disabled]="pageIndex() >= pageCount() - 1">→</button></div>
          </div>
          <div class="preview-layout">
            <div class="sheet-wrap">
              <div class="sheet" [class.back-sheet]="currentPage()?.kind === 'back'">
                <div class="sheet-grid">
                  @for (placement of currentPage()?.placements ?? []; track placement.gridIndex) {
                    <div class="sheet-card">
                      @if (placement.assetKey && previewUrls()[placement.assetKey]) { <img [src]="previewUrls()[placement.assetKey]" alt="Slot {{ (placement.cardSlotIndex ?? 0) + 1 }}"> }
                      @if (cutLines()) { <span class="cut-line"></span> }
                      <span class="safe-line"></span>
                      <span class="sheet-number">{{ placement.cardSlotIndex === null ? '' : placement.cardSlotIndex + 1 }}</span>
                    </div>
                  }
                </div>
                @if (active.settings.cutMarks) { <span class="crop-hint">Marcas de corte activas</span> }
              </div>
            </div>
            <div class="preview-copy"><span class="side-pill">{{ currentPage()?.kind === 'back' ? 'REVERSO · PÁGINA PAR' : 'ANVERSO · PÁGINA IMPAR' }}</span><h3>Posiciones fijas, mismo corte en cada hoja.</h3><p>El espejo seleccionado mueve el reverso a la posición correspondiente. Los huecos de la última hoja se mantienen vacíos.</p><label class="toggle-line"><input type="checkbox" [checked]="cutLines()" (change)="cutLines.set(($any($event.target)).checked)"> Mostrar línea de corte y zona segura</label><p class="mini-legend"><i class="legend-cut"></i> Corte nominal <i class="legend-safe"></i> Zona segura</p></div>
          </div>
        </section>

        <section class="export-panel" [attr.aria-busy]="isExporting()">
          <div class="export-copy"><p class="eyebrow">04 · EXPORTACIÓN</p><h2>Tu PDF está casi listo.</h2><p>Antes de imprimir, comprueba los pares de anverso/reverso con una hoja numerada y confirma los derechos de reproducción.</p>
            @if (lowResolutionCount() > 0) { <label class="confirm-low"><input type="checkbox" [checked]="allowLowResolution()" (change)="allowLowResolution.set(($any($event.target)).checked)"> Acepto exportar {{ lowResolutionCount() }} arte(s) por debajo de 300 ppp</label> }
            <div class="rights-note">La imprenta puede convertir el color. Este PDF no se etiqueta como CMYK.</div>
            @if (isExporting()) {
              <div class="export-status" role="status" aria-live="polite" aria-atomic="true">
                <span class="spinner" aria-hidden="true"></span>
                <div class="export-status-copy"><strong>Generando y validando el PDF</strong><small>Preparando {{ uniqueArtCount() }} artes y {{ pageCount() }} páginas. Puede tardar unos minutos; no cierres esta pestaña.</small></div>
                <div class="export-progress-track" role="progressbar" aria-label="Generación del PDF en curso" aria-valuetext="Preparando los artes y las páginas"><span></span></div>
              </div>
            }
            @if (exportError()) {
              <div class="export-error" role="alert"><strong>No se pudo generar el PDF</strong><span>{{ exportError() }}</span></div>
            }
          </div>
          <button class="button primary export-button" [class.exporting]="isExporting()" (click)="exportPdf()" [disabled]="busy() || (lowResolutionCount() > 0 && !allowLowResolution())" [attr.aria-busy]="isExporting()">
            @if (isExporting()) { <span class="spinner" aria-hidden="true"></span> Generando PDF… }
            @else { <span aria-hidden="true">↓</span> Generar PDF A4 }
          </button>
        </section>
        @if (exportInfo(); as exported) {
          <section class="download-result" role="status"><div><strong>PDF generado · {{ exported.report.pageCount }} páginas</strong><p>Se creó un reporte de validación. La orientación dúplex sigue pendiente de prueba física.</p></div><div class="result-actions"><button class="button primary" (click)="downloadExport(exported.exportId)">Descargar PDF</button><button class="button secondary" (click)="downloadReport(exported.exportId)">Reporte JSON</button></div></section>
        }
        <footer class="workspace-footer"><span>Proyecto temporal · se borra al cerrar o tras 2 horas de inactividad</span><button class="text-button" (click)="closeProject()">Eliminar proyecto</button></footer>
      }

      <footer class="site-footer"><span>MagicPnP <span class="footer-dot">·</span> A4, 3 × 3 <span class="footer-dot">·</span> 63 × 88 mm</span><span>Hecho para preparar y revisar, con cautela, tu próxima impresión.</span></footer>
    </main>
  `,
})
export class AppComponent {
  readonly project = signal<ProjectView | null>(null);
  readonly previewUrls = signal<Record<string, string>>({});
  readonly busy = signal(false);
  readonly downloading = signal(false);
  readonly busyLabel = signal('');
  readonly isExporting = computed(() => this.busyLabel() === 'Maquetando y validando el PDF…');
  readonly error = signal('');
  readonly exportError = signal('');
  readonly notice = signal('');
  readonly manualImageOptions = signal<LocalImageOption[]>([]);
  readonly manualAssignments = signal<ManualImageAssignment[]>([]);
  readonly dragging = signal(false);
  readonly pageIndex = signal(0);
  readonly cutLines = signal(true);
  readonly allowLowResolution = signal(false);
  readonly exportInfo = signal<{ exportId: string; report: { pageCount: number } } | null>(null);
  private projectToken = '';
  private pendingLocalImageFiles: File[] = [];

  readonly pagePlan = computed(() => {
    const active = this.project();
    return active ? buildPagePlan(active.imported.cards, active.settings.duplexMirror) : [];
  });
  readonly pageCount = computed(() => this.pagePlan().length);
  readonly currentPage = computed(() => this.pagePlan()[this.pageIndex()] ?? null);
  readonly uniqueArtCount = computed(() => Object.keys(this.project()?.imported.assets ?? {}).length);
  readonly selectedManualAssignmentCount = computed(() => this.manualAssignments().filter((assignment) => assignment.fileIndex !== null).length);
  readonly lowResolutionCount = computed(() => {
    const active = this.project();
    if (!active) return 0;
    const keys = new Set(active.imported.cards.flatMap((card) => [card.frontAssetKey, card.backAssetKey].filter((key): key is string => !!key)));
    return [...keys].filter((key) => {
      const image = active.assetStatus[key];
      if (!image?.widthPx || !image.heightPx) return false;
      const width = (63 + (active.settings.sourceIncludesBleed ? active.settings.bleedMm * 2 : 0)) / 25.4;
      const height = (88 + (active.settings.sourceIncludesBleed ? active.settings.bleedMm * 2 : 0)) / 25.4;
      return Math.min(image.widthPx / width, image.heightPx / height) < 300;
    }).length;
  });

  async importFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) await this.importXml(file);
    (event.target as HTMLInputElement).value = '';
  }

  onDragOver(event: DragEvent) { event.preventDefault(); this.dragging.set(true); }
  onDragLeave(event: DragEvent) { event.preventDefault(); this.dragging.set(false); }
  async onDrop(event: DragEvent) {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) await this.importXml(file);
  }

  private async importXml(file: File) {
    if (!file.name.toLowerCase().endsWith('.xml') && file.type !== 'application/xml' && file.type !== 'text/xml') {
      this.error.set('Selecciona un archivo XML de MPC Fill.');
      return;
    }
    await this.runBusy('Leyendo el pedido…', async () => {
      const response = await fetch('/api/projects/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ xml: await file.text() }) });
      const data = await this.readJson(response) as { project?: ProjectView; projectToken?: string } & ApiError;
      if (!response.ok || !data.project || !data.projectToken) throw new Error(data.error ?? 'No se pudo importar el XML.');
      this.projectToken = data.projectToken;
      this.project.set(data.project);
      this.pageIndex.set(0);
      this.exportInfo.set(null);
      await this.loadPreviews(data.project);
    });
  }

  async downloadImages() {
    this.downloading.set(true);
    await this.runBusy('Revisando referencias de imagen…', async () => {
      let finished = false;
      const request = this.projectRequest<ApiError & { downloaded?: number; failed?: number; cancelled?: boolean }>('/assets/download', { method: 'POST' });
      const poll = (async () => {
        while (!finished) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));
          if (finished) break;
          try {
            await this.refreshProject();
            const active = this.project();
            if (active) {
              const refs = Object.entries(active.imported.assets).filter(([, asset]) => asset.provider === 'google-drive');
              const ready = refs.filter(([key]) => active.assetStatus[key]?.state === 'ready').length;
              const settled = refs.filter(([key]) => ['ready', 'failed'].includes(active.assetStatus[key]?.state ?? '')).length;
              this.busyLabel.set(`Descargando artes · ${ready} listas, ${Math.max(0, refs.length - settled)} pendientes…`);
            }
          } catch { /* La siguiente consulta vuelve a actualizar el progreso. */ }
        }
      })();
      let data;
      try { data = await request; }
      finally { finished = true; await poll; }
      await this.refreshProject();
      this.notice.set(data.cancelled
        ? `${data.downloaded ?? 0} imágenes descargadas; se canceló el resto.`
        : data.failed ? `${data.downloaded ?? 0} imágenes descargadas; ${data.failed} necesitan revisión o sustitución manual.` : `${data.downloaded ?? 0} imágenes descargadas.`);
    });
    this.downloading.set(false);
  }

  async importImageFolder(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((file) => /\.(?:jpe?g|png|webp)$/i.test(file.name));
    input.value = '';
    const active = this.project();
    if (!active || !files.length) return;

    this.error.set('');
    this.pendingLocalImageFiles = files;
    this.manualImageOptions.set(files.map((file, fileIndex) => ({
      fileIndex,
      label: file.webkitRelativePath || file.name,
      sizeMiB: file.size / (1024 * 1024),
    })));
    const matches = matchLocalAssetFiles(active.imported.assets, files.map((file) => file.name));
    this.manualAssignments.set(matches.ambiguousAssetKeys.map((assetKey) => ({
      assetKey,
      assetName: active.imported.assets[assetKey]?.sourceName ?? assetKey,
      fileIndex: null,
    })));
    if (!matches.matches.length && !matches.ambiguousAssetKeys.length) {
      this.pendingLocalImageFiles = [];
      this.manualImageOptions.set([]);
      this.error.set('No encontré imágenes coincidentes por ID de Drive o nombre de archivo.');
      return;
    }

    await this.runBusy(`Preparando ${matches.matches.length} imágenes locales…`, async () => {
      let completed = 0;
      let uploaded = 0;
      const failed: string[] = [];
      const batchSize = 3;
      for (let offset = 0; offset < matches.matches.length; offset += batchSize) {
        const batch = matches.matches.slice(offset, offset + batchSize);
        await Promise.all(batch.map(async ({ assetKey, fileIndex }) => {
          const file = files[fileIndex]!;
          try {
            const form = new FormData();
            form.append('file', file);
            await this.projectRequest<ApiError & { key?: string }>(`/assets/${encodeURIComponent(assetKey)}/replace`, { method: 'POST', body: form });
            this.invalidatePreview(assetKey);
            uploaded += 1;
          } catch (error) {
            const name = active.imported.assets[assetKey]?.sourceName ?? assetKey;
            failed.push(`${name}: ${error instanceof Error ? error.message : 'error de carga'}`);
          } finally {
            completed += 1;
            this.busyLabel.set(`Subiendo imágenes locales · ${completed}/${matches.matches.length}…`);
          }
        }));
      }

      await this.refreshProject();
      const problemCount = matches.missingAssetKeys.length + matches.ambiguousAssetKeys.length + failed.length;
      const details = [
        matches.missingAssetKeys.length ? `${matches.missingAssetKeys.length} no encontradas` : '',
        matches.ambiguousAssetKeys.length ? `${matches.ambiguousAssetKeys.length} con nombre ambiguo` : '',
        failed.length ? `${failed.length} rechazadas por el servidor` : '',
      ].filter(Boolean).join('; ');
      this.notice.set(`${uploaded} imágenes incorporadas${problemCount ? `; ${details}` : ''}.`);
      if (failed.length) this.error.set(failed.slice(0, 3).join(' · '));
    });
  }

  selectManualFile(assetKey: string, event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    const fileIndex = value === '' ? null : Number(value);
    if (fileIndex !== null && (!Number.isInteger(fileIndex) || !this.pendingLocalImageFiles[fileIndex])) return;
    this.manualAssignments.update((assignments) => assignments.map((assignment) => assignment.assetKey === assetKey
      ? { ...assignment, fileIndex, error: undefined }
      : assignment));
  }

  async uploadManualAssignments() {
    const selected = this.manualAssignments().filter((assignment) => assignment.fileIndex !== null);
    if (!this.project() || !selected.length) return;

    this.error.set('');
    await this.runBusy(`Subiendo ${selected.length} asignaciones manuales…`, async () => {
      const uploaded = new Set<string>();
      const failed = new Map<string, string>();
      const batchSize = 3;
      for (let offset = 0; offset < selected.length; offset += batchSize) {
        const batch = selected.slice(offset, offset + batchSize);
        await Promise.all(batch.map(async (assignment) => {
          const file = this.pendingLocalImageFiles[assignment.fileIndex!];
          if (!file) {
            failed.set(assignment.assetKey, 'El archivo seleccionado ya no está disponible; vuelve a elegirlo.');
            return;
          }
          try {
            const form = new FormData();
            form.append('file', file);
            await this.projectRequest<ApiError & { key?: string }>(`/assets/${encodeURIComponent(assignment.assetKey)}/replace`, { method: 'POST', body: form });
            this.invalidatePreview(assignment.assetKey);
            uploaded.add(assignment.assetKey);
          } catch (error) {
            failed.set(assignment.assetKey, error instanceof Error ? error.message : 'No se pudo subir el archivo.');
          }
        }));
      }

      await this.refreshProject();
      this.manualAssignments.update((assignments) => assignments
        .filter((assignment) => !uploaded.has(assignment.assetKey))
        .map((assignment) => ({ ...assignment, error: failed.get(assignment.assetKey) })));
      const remaining = this.manualAssignments().length;
      if (!remaining) {
        this.pendingLocalImageFiles = [];
        this.manualImageOptions.set([]);
      }
      this.notice.set(`${uploaded.size} imágenes asignadas manualmente; quedan ${remaining} referencias ambiguas.`);
      if (failed.size) this.error.set([...failed.values()].slice(0, 3).join(' · '));
    });
  }

  async cancelDownloads() {
    try {
      await this.projectRequest('/assets/download/cancel', { method: 'POST' });
      this.notice.set('Se solicitó cancelar. Las imágenes ya descargadas se conservan.');
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'No se pudo cancelar la descarga.'); }
  }

  canRetry(key: string, active: ProjectView): boolean {
    return active.imported.assets[key]?.provider === 'google-drive' && active.assetStatus[key]?.state === 'failed';
  }

  assetError(key: string, active: ProjectView): string {
    return active.assetStatus[key]?.error ?? '';
  }

  async retryAsset(key: string) {
    await this.runBusy('Reintentando una imagen…', async () => {
      const data = await this.projectRequest<ApiError>(`/assets/${encodeURIComponent(key)}/download`, { method: 'POST' });
      if (data.error) throw new Error(data.error);
      this.invalidatePreview(key);
      await this.refreshProject();
      this.notice.set('Imagen descargada.');
    });
  }

  async replaceAsset(key: string | null, event: Event) {
    if (!key) return;
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    if (!file) return;
    await this.runBusy('Validando y guardando la imagen…', async () => {
      const form = new FormData();
      form.append('file', file);
      const data = await this.projectRequest<ApiError & { key?: string }>(`/assets/${encodeURIComponent(key)}/replace`, { method: 'POST', body: form });
      if (data.error) throw new Error(data.error);
      if (data.key) this.invalidatePreview(data.key);
      await this.refreshProject();
      this.notice.set('Imagen sustituida.');
    });
  }

  async replaceCommonBack(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = '';
    if (!file) return;
    await this.runBusy('Validando el reverso personalizado…', async () => {
      const form = new FormData();
      form.append('file', file);
      const data = await this.projectRequest<ApiError & { key?: string }>('/back/replace', { method: 'POST', body: form });
      if (data.error) throw new Error(data.error);
      if (data.key) this.invalidatePreview(data.key);
      await this.refreshProject();
      this.notice.set('Reverso común personalizado aplicado a las cartas sin reverso específico.');
    });
  }

  async setBleed(event: Event) { await this.updateSettings({ bleedMm: Number((event.target as HTMLSelectElement).value) as PrintSettings['bleedMm'] }); }
  async setMirror(event: Event) { await this.updateSettings({ duplexMirror: (event.target as HTMLSelectElement).value as PrintSettings['duplexMirror'] }); }
  async setCutMarks(event: Event) { await this.updateSettings({ cutMarks: (event.target as HTMLInputElement).checked }); }
  async setBackMode(event: Event) { await this.updateSettings({ backMode: (event.target as HTMLSelectElement).value as PrintSettings['backMode'] }); }
  async setSourceBleed(event: Event) { await this.updateSettings({ sourceIncludesBleed: (event.target as HTMLSelectElement).value === 'true' }); }

  async changePage(step: number) { this.pageIndex.update((index) => Math.max(0, Math.min(this.pageCount() - 1, index + step))); }

  ppi(key: string | null, active: ProjectView): string {
    if (!key) return '';
    const image = active.assetStatus[key];
    if (!image?.widthPx || !image.heightPx) return '';
    const width = (63 + (active.settings.sourceIncludesBleed ? active.settings.bleedMm * 2 : 0)) / 25.4;
    const height = (88 + (active.settings.sourceIncludesBleed ? active.settings.bleedMm * 2 : 0)) / 25.4;
    return String(Math.round(Math.min(image.widthPx / width, image.heightPx / height)));
  }

  async exportPdf() {
    this.exportInfo.set(null);
    this.exportError.set('');
    await this.runBusy('Maquetando y validando el PDF…', async () => {
      const data = await this.projectRequest<ApiError & { exportId?: string; report?: { pageCount: number } }>('/export', { method: 'POST', body: JSON.stringify({ allowLowResolution: this.allowLowResolution() }) });
      if (!data.exportId || !data.report) throw new Error(data.error ?? 'No se pudo generar el PDF.');
      this.exportInfo.set({ exportId: data.exportId, report: data.report });
      this.notice.set('PDF y reporte validados. La orientación dúplex aún necesita una prueba física.');
    });
    if (this.error()) {
      this.exportError.set(this.error());
      this.error.set('');
    }
  }

  async downloadExport(exportId: string) { await this.downloadArtifact(`/export/${exportId}`, 'magicpnp-soriano-a4.pdf'); }
  async downloadReport(exportId: string) { await this.downloadArtifact(`/export/${exportId}/report`, 'magicpnp-validation-report.json'); }

  async closeProject() {
    const active = this.project();
    if (!active) return;
    await this.runBusy('Borrando el proyecto temporal…', async () => {
      try { await this.projectRequest('', { method: 'DELETE' }); }
      finally {
        Object.values(this.previewUrls()).forEach((url) => URL.revokeObjectURL(url));
        this.previewUrls.set({});
        this.project.set(null);
        this.projectToken = '';
        this.pendingLocalImageFiles = [];
        this.manualImageOptions.set([]);
        this.manualAssignments.set([]);
        this.pageIndex.set(0);
        this.exportInfo.set(null);
      }
      this.notice.set('Proyecto eliminado.');
    });
  }

  private async updateSettings(patch: Partial<PrintSettings>) {
    await this.runBusy('Actualizando ajustes…', async () => {
      const data = await this.projectRequest<ApiError & { settings?: PrintSettings }>('/settings', { method: 'PATCH', body: JSON.stringify(patch) });
      if (!data.settings) throw new Error(data.error ?? 'No se pudieron guardar los ajustes.');
      this.project.update((active) => active ? { ...active, settings: data.settings! } : active);
      this.pageIndex.set(Math.min(this.pageIndex(), this.pageCount() - 1));
      this.exportInfo.set(null);
    });
  }

  private async refreshProject() {
    const data = await this.projectRequest<ProjectView & ApiError>('', { method: 'GET' });
    if (!data.id) throw new Error(data.error ?? 'No se pudo leer el proyecto.');
    this.project.set(data);
    await this.loadPreviews(data);
  }

  private async loadPreviews(active: ProjectView) {
    const urls = { ...this.previewUrls() };
    for (const [key, status] of Object.entries(active.assetStatus)) {
      if (status.state !== 'ready' || urls[key]) continue;
      try {
        const response = await fetch(`/api/projects/${active.id}/assets/${encodeURIComponent(key)}/preview`, { headers: { 'x-project-token': this.projectToken } });
        if (response.ok) urls[key] = URL.createObjectURL(await response.blob());
      } catch { /* El estado y la sustitución manual siguen disponibles. */ }
    }
    this.previewUrls.set(urls);
  }

  private invalidatePreview(key: string) {
    const urls = { ...this.previewUrls() };
    if (urls[key]) URL.revokeObjectURL(urls[key]);
    delete urls[key];
    this.previewUrls.set(urls);
  }

  private async projectRequest<T extends ApiError>(path: string, init: RequestInit): Promise<T> {
    const active = this.project();
    if (!active) throw new Error('No hay un proyecto activo.');
    const response = await fetch(`/api/projects/${active.id}${path}`, {
      ...init,
      headers: { ...(init.body === undefined || init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), 'x-project-token': this.projectToken, ...(init.headers ?? {}) },
    });
    const data = response.status === 204 ? {} as T : await this.readJson(response) as T;
    if (!response.ok) throw new Error(data.error ?? `La solicitud falló (HTTP ${response.status}).`);
    return data as T;
  }

  private async downloadArtifact(path: string, filename: string) {
    await this.runBusy('Preparando la descarga…', async () => {
      const active = this.project();
      if (!active) throw new Error('No hay un proyecto activo.');
      const response = await fetch(`/api/projects/${active.id}${path}`, { headers: { 'x-project-token': this.projectToken } });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as ApiError;
        throw new Error(data.error ?? `La descarga falló (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  private async readJson(response: Response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok && !(data as ApiError).error) throw new Error(`La solicitud falló (HTTP ${response.status}).`);
    return data as ApiError & Record<string, unknown>;
  }

  private async runBusy(label: string, work: () => Promise<void>) {
    this.error.set('');
    this.busy.set(true);
    this.busyLabel.set(label);
    try { await work(); }
    catch (error) { this.error.set(error instanceof Error ? error.message : 'Se produjo un error.'); }
    finally { this.busy.set(false); this.busyLabel.set(''); }
  }
}

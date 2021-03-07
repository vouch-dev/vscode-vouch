// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { reaction } from "mobx";
import {
  commands,
  Comment,
  CommentAuthorInformation,
  CommentController,
  CommentMode,
  comments,
  CommentThread,
  CommentThreadCollapsibleState,
  MarkdownString,
  Range,
  Selection,
  TextDocument,
  TextEditorRevealType,
  Uri,
  window,
  workspace
} from "vscode";
import { SMALL_ICON_URL } from "../constants";
import { store, Review } from "../store";
import {
  getActiveStepMarker,
  getActiveTourNumber,
  getFileUri,
  getStepFileUri,
  getStepLabel,
  getTourTitle
} from "../utils";

const CONTROLLER_ID = "vouch";
const CONTROLLER_LABEL = "Vouch";

let id = 0;

const SHELL_SCRIPT_PATTERN = /^>>\s+(?<script>.*)$/gm;
const COMMAND_PATTERN = /(?<commandPrefix>\(command:[\w+\.]+\?)(?<params>\[[^\]]+\])/gm;
const TOUR_REFERENCE_PATTERN = /(?:\[(?<linkTitle>[^\]]+)\])?\[(?=\s*[^\]\s])(?<tourTitle>[^\]#]+)?(?:#(?<stepNumber>\d+))?\](?!\()/gm;
const CODE_FENCE_PATTERN = /```\w+\n([^`]+)\n```/gm;

export function generatePreviewContent(content: string) {
  return content
    .replace(SHELL_SCRIPT_PATTERN, (_, script) => {
      const args = encodeURIComponent(JSON.stringify([script]));
      return `> [${script}](command:vouch.sendTextToTerminal?${args} "Run \\"${script}\\" in a terminal")`;
    })
    .replace(COMMAND_PATTERN, (_, commandPrefix, params) => {
      const args = encodeURIComponent(JSON.stringify(JSON.parse(params)));
      return `${commandPrefix}${args}`;
    })
    .replace(TOUR_REFERENCE_PATTERN, (_, linkTitle, tourTitle, stepNumber) => {
      if (!tourTitle) {
        const title = linkTitle || `#${stepNumber}`;
        return `[${title}](command:vouch.navigateToStep?${stepNumber} "Navigate to step #${stepNumber}")`;
      }

      const tours = store.activeTour?.tours || store.tours;
      const tour = tours.find(tour => getTourTitle(tour) === tourTitle);
      if (tour) {
        const args: [string, number?] = [tour.title];

        if (stepNumber) {
          args.push(Number(stepNumber));
        }
        const argsContent = encodeURIComponent(JSON.stringify(args));
        const title = linkTitle || tour.title;
        return `[${title}](command:vouch.startTourByTitle?${argsContent} "Start \\"${tour.title}\\" tour")`;
      }

      return _;
    })
    .replace(CODE_FENCE_PATTERN, (_, codeBlock) => {
      const params = encodeURIComponent(JSON.stringify([codeBlock]));
      return `${_}
↪ [Insert Code](command:vouch.insertCodeSnippet?${params} "Insert Code")`;
    });
}

export class CodeTourComment implements Comment {
  public id: string = (++id).toString();
  public contextValue: string = "";
  public author: CommentAuthorInformation = {
    name: CONTROLLER_LABEL,
    iconPath: Uri.parse(SMALL_ICON_URL)
  };
  public body: MarkdownString;

  constructor(
    content: string,
    public label: string = "",
    public parent: CommentThread,
    public mode: CommentMode
  ) {
    const body =
      mode === CommentMode.Preview ? generatePreviewContent(content) : content;

    this.body = new MarkdownString(body);
    this.body.isTrusted = true;
  }
}

let controller: CommentController | null;

export async function focusPlayer() {
  const currentThread = store.activeTour!.thread!;
  showDocument(currentThread.uri, currentThread.range);
}

export async function startPlayer() {
  if (controller) {
    controller.dispose();
  }

  controller = comments.createCommentController(
    CONTROLLER_ID,
    CONTROLLER_LABEL
  );

  // TODO: Correctly limit the commenting ranges
  // to files within the workspace root
  controller.commentingRangeProvider = {
    provideCommentingRanges: (document: TextDocument) => {
      if (store.isRecording) {
        return [new Range(0, 0, document.lineCount, 0)];
      } else {
        return null;
      }
    }
  };
}

export async function stopPlayer() {
  if (store.activeTour?.thread) {
    store.activeTour!.thread.dispose();
    store.activeTour!.thread = null;
  }

  if (controller) {
    controller.dispose();
    controller = null;
  }
}

const VIEW_COMMANDS = new Map([
  ["comments", "workbench.panel.comments"],
  ["console", "workbench.panel.console"],
  ["debug", "workbench.view.debug"],
  ["debug:breakpoints", "workbench.debug.action.focusBreakpointsView"],
  ["debug:callstack", "workbench.debug.action.focusCallStackView"],
  ["debug:variables", "workbench.debug.action.focusVariablesView"],
  ["debug:watch", "workbench.debug.action.focusWatchView"],
  ["explorer", "workbench.view.explorer"],
  ["extensions", "workbench.view.extensions"],
  ["extensions:disabled", "extensions.disabledExtensionList.focus"],
  ["extensions:enabled", "extensions.enabledExtensionList.focus"],
  ["output", "workbench.panel.output"],
  ["problems", "workbench.panel.markers"],
  ["scm", "workbench.view.scm"],
  ["search", "workbench.view.search"],
  ["terminal", "workbench.panel.terminal"]
]);

function getPreviousTour(): Review | undefined {
  const previousTour = store.tours.find(
    tour => tour.nextTour === store.activeTour?.review.title
  );

  if (previousTour) {
    return previousTour;
  }

  const match = store.activeTour?.review.title.match(/^#?(\d+)\s+-/);
  if (match) {
    const previousTourNumber = Number(match[1]) - 1;
    return store.tours.find(tour =>
      tour.title.match(new RegExp(`^#?${previousTourNumber}\\s+[-:]`))
    );
  }
}

function getNextTour(): Review | undefined {
  if (store.activeTour?.review.nextTour) {
    return store.tours.find(
      tour => tour.title === store.activeTour?.review.nextTour
    );
  } else {
    const tourNumber = getActiveTourNumber();
    if (tourNumber) {
      const nextTourNumber = tourNumber + 1;
      return store.tours.find(tour =>
        tour.title.match(new RegExp(`^#?${nextTourNumber}\\s+[-:]`))
      );
    }
  }
}

async function renderCurrentStep() {
  if (store.activeTour!.thread) {
    store.activeTour!.thread.dispose();
  }

  const currentTour = store.activeTour!.review;
  const currentStep = store.activeTour!.step;

  const step = currentTour!.comments[currentStep];
  if (!step) {
    return;
  }

  const workspaceRoot = store.activeTour?.workspaceRoot;
  const uri = await getStepFileUri(step, workspaceRoot, currentTour.ref);

  let line = step.line
    ? step.line - 1
    : step.selection
      ? step.selection.end.line - 1
      : undefined;

  if (step.file && !line) {
    const stepPattern = step.pattern || getActiveStepMarker();
    if (stepPattern) {
      const document = await workspace.openTextDocument(uri);
      const match = document.getText().match(new RegExp(stepPattern));
      if (match) {
        line = document.positionAt(match.index!).line;
      } else {
        line = 2000;
      }
    } else {
      // The step doesn't have a discoverable line number and so
      // stick the step at the end of the file. Unfortunately, there
      // isn't a way to say EOF, so 2000 is a temporary hack.
      line = 2000;
    }
  }

  const range = new Range(line!, 0, line!, 0);
  let label = `Comment #${currentStep + 1} of ${currentTour!.comments.length}`;

  if (currentTour.title) {
    const title = getTourTitle(currentTour);
    label += ` (${title})`;
  }

  store.activeTour!.thread = controller!.createCommentThread(uri, range, []);

  const mode = store.isRecording ? CommentMode.Editing : CommentMode.Preview;
  let content = step.description;

  let hasPreviousStep = currentStep > 0;
  const hasNextStep = currentStep < currentTour.comments.length - 1;
  const isFinalStep = currentStep === currentTour.comments.length - 1;

  const showNavigation = hasPreviousStep || hasNextStep || isFinalStep;
  if (!store.isRecording && showNavigation) {
    content += "\n\n---\n";

    if (hasPreviousStep) {
      const stepLabel = getStepLabel(
        currentTour,
        currentStep - 1,
        false,
        false
      );
      const suffix = stepLabel ? ` (${stepLabel})` : "";
      content += `← [Previous${suffix}](command:vouch.previousTourStep "Navigate to previous comment")`;
    } else {
      const previousTour = getPreviousTour();
      if (previousTour) {
        hasPreviousStep = true;

        const tourTitle = getTourTitle(previousTour);
        const argsContent = encodeURIComponent(
          JSON.stringify([previousTour.title])
        );
        content += `← [Previous Tour (${tourTitle})](command:vouch.startTourByTitle?${argsContent} "Navigate to previous tour")`;
      }
    }

    const prefix = hasPreviousStep ? " | " : "";
    if (hasNextStep) {
      const stepLabel = getStepLabel(
        currentTour,
        currentStep + 1,
        false,
        false
      );
      const suffix = stepLabel ? ` (${stepLabel})` : "";
      content += `${prefix}[Next${suffix}](command:vouch.nextTourStep "Navigate to next comment") →`;
    } else if (isFinalStep) {
      const nextTour = getNextTour();
      if (nextTour) {
        const tourTitle = getTourTitle(nextTour);
        const argsContent = encodeURIComponent(
          JSON.stringify([nextTour.title])
        );
        content += `${prefix}[Next Tour (${tourTitle})](command:vouch.finishTour?${argsContent} "Start next tour")`;
      } else {
        content += `${prefix}[Finish Review](command:vouch.finishTour "Finish the review")`;
      }
    }
  }

  const comment = new CodeTourComment(
    content,
    label,
    store.activeTour!.thread!,
    mode
  );

  // @ts-ignore
  store.activeTour!.thread.canReply = false;

  store.activeTour!.thread.comments = [comment];

  const contextValues = [];
  if (hasPreviousStep) {
    contextValues.push("hasPrevious");
  }

  if (hasNextStep) {
    contextValues.push("hasNext");
  }

  store.activeTour!.thread.contextValue = contextValues.join(".");
  store.activeTour!.thread.collapsibleState =
    CommentThreadCollapsibleState.Expanded;

  let selection;
  if (step.selection) {
    // Adjust the 1-based positions
    // to the 0-based positions that
    // VS Code's editor uses.
    selection = new Selection(
      step.selection.start.line - 1,
      step.selection.start.character - 1,
      step.selection.end.line - 1,
      step.selection.end.character - 1
    );
  } else {
    selection = new Selection(range.start, range.end);
  }

  await showDocument(uri, range, selection);

  if (step.directory) {
    const directoryUri = getFileUri(step.directory, workspaceRoot);
    commands.executeCommand("revealInExplorer", directoryUri);
  } else if (step.view) {
    const commandName = VIEW_COMMANDS.has(step.view)
      ? VIEW_COMMANDS.get(step.view)!
      : `${step.view}.focus`;

    try {
      await commands.executeCommand(commandName);
    } catch {
      window.showErrorMessage(
        `The current tour step is attempting to focus a view which isn't available: ${step.view}. Please check the tour and try again.`
      );
    }
  }

  if (step.commands) {
    step.commands.forEach(async command => {
      let name = command,
        args: any[] = [];

      if (command.includes("?")) {
        const parts = command.split("?");
        name = parts[0];
        args = JSON.parse(parts[1]);
      }

      try {
        await commands.executeCommand(name, ...args);
      } catch {
        // Silently fail, since it's unclear if the
        // command was critical to the step or not.
      }
    });
  }
}

async function showDocument(uri: Uri, range: Range, selection?: Selection) {
  const document =
    window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === uri.toString()
    ) || (await window.showTextDocument(uri, { preserveFocus: true }));

  // TODO: Figure out how to force focus when navigating
  // to documents which are already open.

  if (selection) {
    document.selection = selection;
  }

  document.revealRange(range, TextEditorRevealType.InCenter);
}

// Watch for changes to the active tour property,
// and automatically re-render the current step in response.
reaction(
  () => [
    store.activeTour
      ? [
        store.activeTour.step,
        store.activeTour.review.title,
        store.activeTour.review.comments.map(step => [
          step.title,
          step.description,
          step.line,
          step.directory,
          step.view
        ])
      ]
      : null
  ],
  () => {
    if (store.activeTour) {
      renderCurrentStep();
    }
  }
);

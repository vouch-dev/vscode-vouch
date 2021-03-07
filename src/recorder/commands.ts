// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { action, comparer, runInAction } from "mobx";
import * as path from "path";
import * as vscode from "vscode";
import { workspace } from "vscode";
import { EXTENSION_NAME, FS_SCHEME_CONTENT } from "../constants";
import { PlayerCodeReviewComment } from "../player";
import { Review, store, StoreCodeReviewComment } from "../store";
import {
  endCurrentCodeTour,
  exportTour,
  onDidEndTour,
  startCodeTour
} from "../store/actions";
import { CodeTourNode, CodeTourStepNode } from "../tree/nodes";
import { getActiveWorkspacePath, getRelativePath } from "../utils";

export async function saveTour(tour: Review) {
  const uri = vscode.Uri.parse(tour.id);
  const newTour = {
    $schema: "https://aka.ms/vouch-schema",
    ...tour
  };
  delete newTour.id;
  newTour.comments.forEach(step => {
    delete step.markerTitle;
  });

  const tourContent = JSON.stringify(newTour, null, 2);

  const bytes = new TextEncoder().encode(tourContent);
  return vscode.workspace.fs.writeFile(uri, bytes);
}

export function registerRecorderCommands() {
  function getTourFileUri(workspaceRoot: vscode.Uri, title: string) {
    const file = title
      .toLocaleLowerCase()
      .replace(/\s/g, "-")
      .replace(/[^\w\d-_]/g, "");

    const prefix = workspaceRoot.path.endsWith("/")
      ? workspaceRoot.path
      : `${workspaceRoot.path}/`;

    return workspaceRoot.with({
      path: `${prefix}.vscode/reviews/${file}.review`
    });
  }

  async function checkIfTourExists(workspaceRoot: vscode.Uri, title: string) {
    const uri = getTourFileUri(workspaceRoot, title);

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  async function writeTourFile(
    workspaceRoot: vscode.Uri,
    title: string | vscode.Uri,
    ref?: string
  ): Promise<Review> {
    const uri =
      typeof title === "string" ? getTourFileUri(workspaceRoot, title) : title;

    const tourTitle =
      typeof title === "string"
        ? title
        : path.basename(title.path).replace(".review", "");

    const tour = { title: tourTitle, comments: [] };
    if (ref && ref !== "HEAD") {
      (tour as any).ref = ref;
    }

    const tourContent = JSON.stringify(tour, null, 2);
    const bytes = new TextEncoder().encode(tourContent);
    await vscode.workspace.fs.writeFile(uri, bytes);

    (tour as any).id = decodeURIComponent(uri.toString());

    // @ts-ignore
    return tour as Review;
  }

  interface WorkspaceQuickPickItem extends vscode.QuickPickItem {
    uri: vscode.Uri;
  }

  const REENTER_TITLE_RESPONSE = "Re-enter title";
  async function recordTourInternal(
    tourTitle: string | vscode.Uri,
    workspaceRoot?: vscode.Uri
  ) {
    if (!workspaceRoot) {
      workspaceRoot = workspace.workspaceFolders![0].uri;

      if (workspace.workspaceFolders!.length > 1) {
        const items: WorkspaceQuickPickItem[] = workspace.workspaceFolders!.map(
          ({ name, uri }) => ({
            label: name,
            uri: uri
          })
        );

        const response = await vscode.window.showQuickPick(items, {
          placeHolder: "Select the workspace to save the tour to"
        });

        if (!response) {
          return;
        }

        workspaceRoot = response.uri;
      }
    }

    if (typeof tourTitle === "string") {
      const tourExists = await checkIfTourExists(workspaceRoot, tourTitle);

      if (tourExists) {
        const response = await vscode.window.showErrorMessage(
          `This workspace already includes a tour with the title "${tourTitle}."`,
          REENTER_TITLE_RESPONSE,
          "Overwrite existing tour"
        );

        if (response === REENTER_TITLE_RESPONSE) {
          return vscode.commands.executeCommand(
            `${EXTENSION_NAME}.recordTour`,
            workspaceRoot,
            tourTitle
          );
        } else if (!response) {
          // If the end-user closes the error
          // dialog, then cancel the recording.
          return;
        }
      }
    }

    const ref = "HEAD";
    const tour = await writeTourFile(workspaceRoot, tourTitle, ref);

    startCodeTour(tour, 0, workspaceRoot, true);

    vscode.window.showInformationMessage(
      "Review recording started! Begin adding comments by opening a file and clicking the + button to the left of a line of code."
    );
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.recordTour`,
    async (workspaceRoot?: vscode.Uri, placeHolderTitle?: string) => {
      const inputBox = vscode.window.createInputBox();
      inputBox.title =
        "Specify the title of the review, or save it to a specific location";
      inputBox.placeholder = placeHolderTitle;
      inputBox.buttons = [
        {
          iconPath: new vscode.ThemeIcon("save-as"),
          tooltip: "Save tour as..."
        }
      ];

      inputBox.onDidAccept(async () => {
        inputBox.hide();

        if (!inputBox.value) {
          return;
        }

        recordTourInternal(inputBox.value, workspaceRoot);
      });

      inputBox.onDidTriggerButton(async button => {
        inputBox.hide();

        const uri = await vscode.window.showSaveDialog({
          filters: {
            Reviews: ["review"]
          },
          saveLabel: "Save Review"
        });

        if (!uri) {
          return;
        }

        const disposeEndTourHandler = onDidEndTour(async tour => {
          if (tour.id === decodeURIComponent(uri.toString())) {
            disposeEndTourHandler.dispose();

            if (
              await vscode.window.showInformationMessage(
                "Would you like to export this review?",
                "Export Review"
              )
            ) {
              const content = await exportTour(tour);
              vscode.workspace.fs.writeFile(uri, Buffer.from(content));
            }
          }
        });

        recordTourInternal(uri, workspaceRoot);
      });

      inputBox.show();
    }
  );

  function getStepSelection() {
    const activeEditor = vscode.window.activeTextEditor;
    if (
      activeEditor &&
      activeEditor.selection &&
      !activeEditor.selection.isEmpty
    ) {
      const { start, end } = activeEditor.selection;

      // Convert the selection from 0-based
      // to 1-based to make it easier to
      // edit the JSON tour file by hand.
      const selection = {
        start: {
          line: start.line + 1,
          character: start.character + 1
        },
        end: {
          line: end.line + 1,
          character: end.character + 1
        }
      };

      const previousStep = store.activeTour!.review.comments[
        store.activeTour!.step - 1
      ];

      // Check whether the end-user forgot to "reset"
      // the selection from the previous step, and if so,
      // ignore it from this step since it's not likely useful.
      if (
        !previousStep ||
        !previousStep.selection ||
        !comparer.structural(previousStep.selection, selection)
      ) {
        return selection;
      }
    }
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addContentStep`,
    action(async () => {
      const value = store.activeTour?.step === -1 ? "Introduction" : "";
      const title = await vscode.window.showInputBox({
        prompt: "Specify the title of the step",
        value
      });

      if (!title) {
        return;
      }

      const stepNumber = ++store.activeTour!.step;
      const tour = store.activeTour!.review;

      tour.comments.splice(stepNumber, 0, {
        title,
        description: "",
        summary: "warn"
      });

      saveTour(tour);
    })
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addDirectoryStep`,
    action(async (uri: vscode.Uri) => {
      const stepNumber = ++store.activeTour!.step;
      const tour = store.activeTour!.review;

      const workspaceRoot = getActiveWorkspacePath();
      const directory = getRelativePath(workspaceRoot, uri.path);

      tour.comments.splice(stepNumber, 0, {
        directory,
        description: "",
        summary: "warn"
      });

      saveTour(tour);
    })
  );

  vscode.commands.registerTextEditorCommand(
    `${EXTENSION_NAME}.addSelectionStep`,
    action(async (editor: vscode.TextEditor) => {
      addSelectionStep("pass", editor);
    })
  );

  vscode.commands.registerTextEditorCommand(
    `${EXTENSION_NAME}.addSelectionStepPass`,
    action(async (editor: vscode.TextEditor) => {
      addSelectionStep("pass", editor);
    })
  );

  vscode.commands.registerTextEditorCommand(
    `${EXTENSION_NAME}.addSelectionStepWarn`,
    action(async (editor: vscode.TextEditor) => {
      addSelectionStep("warn", editor);
    })
  );

  vscode.commands.registerTextEditorCommand(
    `${EXTENSION_NAME}.addSelectionStepFail`,
    action(async (editor: vscode.TextEditor) => {
      addSelectionStep("fail", editor);
    })
  );

  function addSelectionStep(summary: string, editor: vscode.TextEditor) {
    const stepNumber = ++store.activeTour!.step;
    const tour = store.activeTour!.review;

    const workspaceRoot = getActiveWorkspacePath();
    const file = getRelativePath(workspaceRoot, editor.document.uri.path);

    tour.comments.splice(stepNumber, 0, {
      file,
      selection: getStepSelection(),
      description: "",
      summary: summary
    });

    saveTour(tour);
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.addTourStep`,
    action(async (reply: vscode.CommentReply) => {
      if (store.activeTour!.thread) {
        store.activeTour!.thread.dispose();
      }

      store.activeTour!.thread = reply.thread;

      const tour = store.activeTour!.review;
      const thread = store.activeTour!.thread;

      const workspaceRoot = getActiveWorkspacePath();
      const file = getRelativePath(workspaceRoot, thread!.uri.path);

      const step: StoreCodeReviewComment = {
        file,
        description: reply.text,
        summary: "warn"
      };

      step.line = thread!.range.start.line + 1;
      store.activeTour!.step++;

      const stepNumber = store.activeTour!.step;

      const selection = getStepSelection();
      if (selection) {
        (step as any).selection = selection;
      }

      tour.comments.splice(stepNumber, 0, step);

      saveTour(tour);

      let label = `Comment #${stepNumber + 1} of ${tour.comments.length}`;

      const contextValues = [];
      if (tour.comments.length > 1) {
        contextValues.push("hasPrevious");
      }

      if (stepNumber < tour.comments.length - 1) {
        contextValues.push("hasNext");
      }

      thread!.contextValue = contextValues.join(".");
      thread!.comments = [
        new PlayerCodeReviewComment(
          reply.text,
          step.summary.toLocaleUpperCase(),
          label,
          thread!,
          vscode.CommentMode.Preview
        )
      ];
    })
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.editTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      store.isRecording = true;
      await vscode.commands.executeCommand(
        "setContext",
        "vouch:recording",
        true
      );

      if (node instanceof CodeTourNode) {
        startCodeTour(node.tour);
      } else if (store.activeTour) {
        // We need to re-start the tour so that the associated
        // comment controller is put into edit mode
        startCodeTour(
          store.activeTour!.review,
          store.activeTour!.step,
          store.activeTour.workspaceRoot
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.editTourAtStep`,
    async (node: CodeTourStepNode) => {
      startCodeTour(node.tour, node.stepNumber, undefined, true);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.previewTour`,
    async (node: CodeTourNode | vscode.CommentThread) => {
      store.isRecording = false;
      await vscode.commands.executeCommand(
        "setContext",
        "vouch:recording",
        false
      );

      if (node instanceof CodeTourNode) {
        startCodeTour(node.tour);
      } else if (store.activeTour) {
        // We need to re-start the tour so that the associated
        // comment controller is put into edit mode
        startCodeTour(
          store.activeTour!.review,
          store.activeTour!.step,
          store.activeTour.workspaceRoot
        );
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.makeTourPrimary`,
    async (node: CodeTourNode) => {
      const primaryTour = node.tour;
      primaryTour.isPrimary = true;
      saveTour(primaryTour);

      store.tours
        .filter(tour => tour.id !== primaryTour.id && tour.isPrimary)
        .forEach(tour => {
          delete tour.isPrimary;
          saveTour(tour);
        });
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.unmakeTourPrimary`,
    async (node: CodeTourNode) => {
      const primaryTour = node.tour;
      delete primaryTour.isPrimary;
      saveTour(primaryTour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.saveTourStep`,
    async (comment: PlayerCodeReviewComment) => {
      if (!comment.parent) {
        return;
      }

      runInAction(() => {
        const content =
          comment.body instanceof vscode.MarkdownString
            ? comment.body.value
            : comment.body;
        const tourStep = store.activeTour!.review!.comments[store.activeTour!.step];
        tourStep.description = content;

        const selection = getStepSelection();
        if (selection) {
          tourStep.selection = selection;
        }
      });

      await saveTour(store.activeTour!.review);
    }
  );

  async function updateTourProperty(tour: Review, property: string) {
    const propertyValue = await vscode.window.showInputBox({
      prompt: `Enter the ${property} for this review`,
      // @ts-ignore
      value: tour[property]
    });

    if (!propertyValue) {
      return;
    }

    // @ts-ignore
    tour[property] = propertyValue;
    await saveTour(tour);

    return propertyValue;
  }

  function moveStep(
    movement: number,
    node: CodeTourStepNode | PlayerCodeReviewComment
  ) {
    let tour: Review, stepNumber: number;

    if (node instanceof PlayerCodeReviewComment) {
      tour = store.activeTour!.review;
      stepNumber = store.activeTour!.step;
    } else {
      tour = node.tour;
      stepNumber = node.stepNumber;
    }

    runInAction(async () => {
      const step = tour.comments[stepNumber];
      tour.comments.splice(stepNumber, 1);
      tour.comments.splice(stepNumber + movement, 0, step);

      // If the user is moving the currently active step, then move
      // the tour play along with it as well.
      if (
        store.activeTour &&
        tour.id === store.activeTour.review.id &&
        stepNumber === store.activeTour.step
      ) {
        store.activeTour.step += movement;
      }

      await saveTour(tour);
    });
  }

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.moveTourStepBack`,
    moveStep.bind(null, -1)
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.moveTourStepForward`,
    moveStep.bind(null, 1)
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourDescription`,
    (node: CodeTourNode) => updateTourProperty(node.tour, "description")
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourTitle`,
    async (node: CodeTourNode) => {
      const oldTitle = node.tour.title;
      const newTitle = await updateTourProperty(node.tour, "title");

      // If the user updated the tour's title, then we need to check
      // whether there are other tours that reference this tour, and
      // if so, we want to update the tour reference to match the new title.
      if (newTitle) {
        store.tours
          .filter(tour => tour.nextTour === oldTitle)
          .forEach(tour => {
            tour.nextTour = newTitle;
            saveTour(tour);
          });
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepTitle`,
    async (node: CodeTourStepNode) => {
      const step = node.tour.comments[node.stepNumber];
      step.title = await vscode.window.showInputBox({
        prompt: `Enter the title for this review comment`,
        value: step.title || ""
      });

      saveTour(node.tour);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.changeTourStepLine`,
    async (comment: PlayerCodeReviewComment) => {
      const step = store.activeTour!.review.comments[store.activeTour!.step];
      const response = await vscode.window.showInputBox({
        prompt: `Enter the new line # for this review comment (Leave blank to use the selection/document end)`,
        value: step.line?.toString() || ""
      });

      if (response) {
        step.line = Number(response);
      } else {
        delete step.line;
      }

      saveTour(store.activeTour!.review);
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.deleteTour`,
    async (node: CodeTourNode, additionalNodes: CodeTourNode[]) => {
      const messageSuffix = additionalNodes
        ? `${additionalNodes.length} selected reviews`
        : `"${node.tour.title}" review`;

      const buttonSuffix = additionalNodes
        ? `${additionalNodes.length} Reviews`
        : "Review";

      if (
        await vscode.window.showInformationMessage(
          `Are you sure your want to delete the ${messageSuffix}?`,
          `Delete ${buttonSuffix}`
        )
      ) {
        const tourIds = (additionalNodes || [node]).map(node => node.tour.id);

        if (store.activeTour && tourIds.includes(store.activeTour.review.id)) {
          await endCurrentCodeTour();
        }

        tourIds.forEach(tourId => {
          const uri = vscode.Uri.parse(tourId);
          vscode.workspace.fs.delete(uri);
        });
      }
    }
  );

  vscode.commands.registerCommand(
    `${EXTENSION_NAME}.deleteTourStep`,
    async (
      node: CodeTourStepNode | PlayerCodeReviewComment,
      additionalNodes: CodeTourStepNode[]
    ) => {
      let tour: Review, steps: number[];
      let messageSuffix = "selected comment";
      let buttonSuffix = "Comment";

      if (node instanceof CodeTourStepNode) {
        tour = node.tour;

        if (additionalNodes) {
          buttonSuffix = `${additionalNodes.length} Comments`;
          messageSuffix = `${additionalNodes.length} selected comments`;

          steps = additionalNodes.map(n => n.stepNumber);
        } else {
          steps = [node.stepNumber];
        }
      } else {
        tour = store.activeTour!.review;
        steps = [store.activeTour!.step];

        node.parent.dispose();
      }

      if (
        await vscode.window.showInformationMessage(
          `Are you sure your want to delete the ${messageSuffix}?`,
          `Delete ${buttonSuffix}`
        )
      ) {
        steps.forEach(step => tour.comments.splice(step, 1));

        if (store.activeTour && store.activeTour.review.id === tour.id) {
          const previousSteps = steps.filter(
            step => step <= store.activeTour!.step
          );
          if (
            previousSteps.length > 0 &&
            (store.activeTour!.step > 0 || tour.comments.length === 0)
          ) {
            store.activeTour!.step -= previousSteps.length;
          }

          if (steps.includes(store.activeTour.step)) {
            // The only reason that a Vouch content editor would be
            // open is because it was associated with the current step.
            // So detect if there are any, and if so, hide them.
            vscode.window.visibleTextEditors.forEach(editor => {
              if (editor.document.uri.scheme === FS_SCHEME_CONTENT) {
                editor.hide();
              }
            });
          }
        }

        saveTour(tour);
      }
    }
  );

}

import { distance } from "fastest-levenshtein";
import Parser from "web-tree-sitter";
import { DiffLine } from "../..";
import { myersDiff } from "../../diff/myers";
import { getParserForFile } from "../../util/treeSitter";
import { findInAst } from "./findInAst";

type LazyBlockReplacements = Array<{
  lazyBlockNode: Parser.SyntaxNode;
  replacementNodes: Parser.SyntaxNode[];
}>;

function reconstructNewFile(
  oldFile: string,
  newFile: string,
  lazyBlockReplacements: LazyBlockReplacements,
): string {
  // Sort acc by reverse line number
  lazyBlockReplacements
    .sort((a, b) => a.lazyBlockNode.startIndex - b.lazyBlockNode.startIndex)
    .reverse();

  // Reconstruct entire file by replacing lazy blocks with the replacement nodes
  const oldFileLines = oldFile.split("\n");
  const newFileChars = newFile.split("");
  for (const { lazyBlockNode, replacementNodes } of lazyBlockReplacements) {
    // Get the full string from the replacement nodes
    let replacementText = "";
    if (replacementNodes.length > 0) {
      const startPosition = replacementNodes[0].startPosition;
      const endPosition =
        replacementNodes[replacementNodes.length - 1].endPosition;
      const replacementLines = oldFileLines.slice(
        startPosition.row,
        endPosition.row + 1,
      );
      replacementLines[0] = replacementLines[0].slice(startPosition.column);
      replacementLines[replacementLines.length - 1] = replacementLines[
        replacementLines.length - 1
      ].slice(0, endPosition.column);
      replacementText = replacementLines.join("\n");

      // Replace the lazy block
      newFileChars.splice(
        lazyBlockNode.startIndex,
        lazyBlockNode.text.length,
        replacementText,
      );
    } else {
      // If there are no replacements, then we want to strip the surrounding whitespace
      // The example in calculator-exp.js.diff is a test where this is necessary
      const lazyBlockStart = lazyBlockNode.startIndex;
      const lazyBlockEnd = lazyBlockNode.endIndex - 1;

      // Remove leading whitespace up to two new lines
      let startIndex = lazyBlockStart;
      let newLinesFound = 0;
      while (
        startIndex > 0 &&
        newFileChars[startIndex - 1].trim() === "" &&
        newLinesFound < 2
      ) {
        startIndex--;
        if (newFileChars[startIndex - 1] === "\n") {
          newLinesFound++;
        }
      }

      // Remove trailing whitespace up to two new lines
      const charAfter = newFileChars[lazyBlockEnd + 1];
      const secondCharAfter = newFileChars[lazyBlockEnd + 2];
      let endIndex = lazyBlockEnd;
      if (charAfter === "\n") {
        endIndex++;
        if (secondCharAfter === "\n") {
          endIndex++;
        }
      }

      // Remove the lazy block
      newFileChars.splice(startIndex, endIndex - startIndex + 1);
    }
  }

  return newFileChars.join("");
}

// TODO: If we don't have high confidence, return undefined to fall back to slower methods
export async function deterministicApplyLazyEdit(
  oldFile: string,
  newLazyFile: string,
  filename: string,
): Promise<DiffLine[] | undefined> {
  const parser = await getParserForFile(filename);
  if (!parser) {
    return undefined;
  }

  const oldTree = parser.parse(oldFile);
  const newTree = parser.parse(newLazyFile);

  // If there is no lazy block anywhere, we add our own to the outsides
  // so that large chunks of the file don't get removed
  if (!findInAst(newTree.rootNode, isLazyBlock)) {
  }

  const acc: LazyBlockReplacements = [];
  findLazyBlockReplacements(oldTree.rootNode, newTree.rootNode, acc);

  const newFullFile = reconstructNewFile(oldFile, newLazyFile, acc);
  const diff = myersDiff(oldFile, newFullFile);
  return diff;
}

const LAZY_COMMENT_REGEX = /\.{3}\s*(.+?)\s*\.{3}/;
export function isLazyLine(text: string): boolean {
  return LAZY_COMMENT_REGEX.test(text);
}

function isLazyBlock(node: Parser.SyntaxNode): boolean {
  return node.type.includes("comment") && isLazyLine(node.text);
}

/**
 * Determine whether two nodes are similar
 * @param a
 * @param b
 * @returns
 */
function nodesAreSimilar(a: Parser.SyntaxNode, b: Parser.SyntaxNode): boolean {
  if (a.type !== b.type) {
    return false;
  }

  // Check if they have the same name
  if (
    a.childForFieldName("name") !== null &&
    a.childForFieldName("name")?.text === b.childForFieldName("name")?.text
  ) {
    return true;
  }

  if (
    a.namedChildren[0]?.text === b.namedChildren[0]?.text &&
    a.children[1]?.text === b.children[1]?.text
  ) {
    return true;
  }

  const lineOneA = a.text.split("\n")[0];
  const lineOneB = b.text.split("\n")[0];

  const levDist = distance(lineOneA, lineOneB);
  return levDist / Math.min(lineOneA.length, lineOneB.length) <= 0.2;
}

function nodesAreExact(a: Parser.SyntaxNode, b: Parser.SyntaxNode): boolean {
  return a.text === b.text;
}

/**
 * Should be like Myers diff, but lazy blocks consume all nodes until the next match
 * @param newNode
 * @param oldNode
 * @returns
 */
function findLazyBlockReplacements(
  oldNode: Parser.SyntaxNode,
  newNode: Parser.SyntaxNode,
  acc: LazyBlockReplacements,
): void {
  // Base case
  if (nodesAreExact(oldNode, newNode)) {
    return;
  }

  // Other base case: no lazy blocks => use line-by-line diff
  if (!findInAst(newNode, isLazyBlock)) {
    return;
  }

  const leftChildren = oldNode.namedChildren;
  const rightChildren = newNode.namedChildren;
  let isLazy = false;
  let currentLazyBlockNode: Parser.SyntaxNode | undefined = undefined;
  const currentLazyBlockReplacementNodes = [];

  while (leftChildren.length > 0 && rightChildren.length > 0) {
    const L = leftChildren[0];
    const R = rightChildren[0];

    // Consume lazy block
    if (isLazyBlock(R)) {
      // Enter "lazy mode"
      isLazy = true;
      currentLazyBlockNode = R;
      rightChildren.shift();
      continue;
    }

    // Look for the first match of L
    const index = rightChildren.findIndex((node) => nodesAreSimilar(L, node));

    if (index === -1) {
      // No match
      if (isLazy) {
        // Add to replacements if in lazy mode
        currentLazyBlockReplacementNodes.push(L);
      }

      // Consume
      leftChildren.shift();
    } else {
      // Match found, insert all right nodes before the match
      for (let i = 0; i < index; i++) {
        rightChildren.shift();
      }

      // then recurse at the match
      findLazyBlockReplacements(L, rightChildren[0], acc);

      // then consume L and R
      leftChildren.shift();
      rightChildren.shift();

      // Exit "lazy mode"
      if (isLazy) {
        // Record the replacement lines
        acc.push({
          lazyBlockNode: currentLazyBlockNode!,
          replacementNodes: [...currentLazyBlockReplacementNodes],
        });
        isLazy = false;
        currentLazyBlockReplacementNodes.length = 0;
        currentLazyBlockNode = undefined;
      }
    }
  }

  if (isLazy) {
    acc.push({
      lazyBlockNode: currentLazyBlockNode!,
      replacementNodes: [...currentLazyBlockReplacementNodes, ...leftChildren],
    });
  }

  // Cut out any extraneous lazy blocks
  for (const R of rightChildren) {
    if (isLazyBlock(R)) {
      acc.push({
        lazyBlockNode: R,
        replacementNodes: [],
      });
    }
  }
}

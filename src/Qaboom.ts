import { Container, HTMLText, Point, Ticker } from "pixi.js";
import "pixi.js/math-extras";
import { uniqWith } from "lodash-es";
import MeasurementPiece from "./MeasurementPiece";
import { measure } from "./quantum";
import { DOWN, LEFT, neighbors, RIGHT, UP } from "./points";
import { CELL_SIZE, BOARD_WIDTH, BOARD_HEIGHT } from "./constants";
import Deck from "./Deck";
import QubitPair from "./QubitPair";
import Board, { inBounds } from "./Board";

type State = "game" | "measure" | "fall";

const RATES = {
  game: 500,
  measure: 150,
  fall: 150,
};

const startingCell = new Point(Math.floor(BOARD_WIDTH / 2 - 1), 0);

// The main Qaboom gameplay loop
export default class Qaboom {
  onGameOver?: () => void;

  view: Container;
  board: Board;
  deck: Deck;
  scoreboard: HTMLText;
  // Either a pair of qubit, a gate, or a measurement
  current: QubitPair | MeasurementPiece | null = null;
  currentPosition = startingCell;
  currentState: State = "game";
  #score: number = 0;

  // State relating to measurement
  measureQueue: Point[] = [];
  measured: Point[] = [];
  visited: Point[] = [];

  time: number = 0;
  nextTime: number = 0;

  constructor() {
    this.view = new Container();
    // TODO be able to reference the "current" position based on the board.
    this.view.position = { x: 50, y: 50 };

    this.board = new Board();
    // this.board.view.position = { x: 50, y: 50 };

    this.deck = new Deck();
    this.deck.view.position = { x: 325, y: 0 };
    this.deck.view.scale = 0.75;

    // this.grid = this.initGrid();
    this.scoreboard = new HTMLText({
      text: "" + this.score,
      style: {
        align: "center",
        fill: "white",
        fontFamily: "monospace",
        fontSize: 32,
      },
    });
    this.scoreboard.position = { x: 0, y: -35 };

    this.initialize();
  }

  initialize() {
    this.score = 0;
    this.view.removeChildren();

    this.view.addChild(this.scoreboard);
    this.view.addChild(this.board.view);
    this.view.addChild(this.deck.view);

    this.board.initialize();
    this.newCurrent();
  }

  get score() {
    return this.#score;
  }

  set score(value: number) {
    this.#score = value;
    this.scoreboard.text = `${this.#score * 100}`;
  }

  show(parent: Container) {
    parent.addChild(this.view);
    document.addEventListener("keydown", this.handleKeyDown);
  }

  hide() {
    this.view.parent.removeChild(this.view);
    document.removeEventListener("keydown", this.handleKeyDown);
  }

  tick = (time: Ticker) => {
    if (this.time >= this.nextTime) {
      if (this.currentState === "game") {
        this.step();
      } else if (this.currentState === "measure") {
        this.measureStep();
      } else {
        this.fallStep();
      }
      this.nextTime = this.time + RATES[this.currentState];
    }
    this.time += time.deltaMS;
  };

  step() {
    // If it doesn't touch the floor or another qubit in the grid,
    // move it down.
    const occupiedBelow =
      this.currentPosition.y + 1 === BOARD_HEIGHT ||
      !!this.board.getPiece(this.currentPosition.add(DOWN)) ||
      (this.current instanceof QubitPair &&
        this.current.orientation === "horizontal" &&
        !!this.board.getPiece(this.currentPosition.add(RIGHT).add(DOWN)));

    if (occupiedBelow) {
      this.resolve();
    } else {
      this.setCurrentPosition(this.currentPosition.add(DOWN));
    }
  }

  // Resolve the current piece's action when it can't move any more.
  resolve() {
    // If it's a pair of qubits, just add it to the grid.
    if (this.current instanceof QubitPair) {
      const secondPosition = this.currentPosition.add(
        this.current.orientation === "vertical" ? UP : RIGHT
      );
      // If the second position of the qubit is higher than the initial position,
      // it's game over.
      if (secondPosition.y < 0) {
        this.onGameOver?.();
        return;
      }
      this.board.setPiece(this.currentPosition, this.current.first);
      this.board.setPiece(secondPosition, this.current.second);
      // If the starting cell is occupied, it's game over.
      if (this.board.containsPoint(startingCell)) {
        this.onGameOver?.();
        return;
      }
      this.currentState = "fall";
    } else if (this.current instanceof MeasurementPiece) {
      // If it's a measurement, trigger the measurement reaction chain.
      this.currentState = "measure";
      this.measureQueue = neighbors(this.currentPosition).filter((p) =>
        this.board.containsPoint(p)
      );
    }
    // If it's a gate, trigger the gate.
  }

  measureStep() {
    if (this.measureQueue.length === 0) {
      this.resolveMeasurement();
      return;
    }
    let newQueue: Point[] = [];
    const current = this.current as MeasurementPiece;
    this.visited = this.visited.concat(this.measureQueue);
    for (const point of this.measureQueue) {
      const qubit = this.board.getPiece(point);
      if (!qubit) continue;
      const measured = measure(qubit.value, current.base);
      if (measured) {
        qubit.setValue(current.base);
        this.measured.push(point);
        // Add unvisited neighbors to the new queue.
        for (const nbr of neighbors(point)) {
          if (inBounds(nbr) && !this.visited.some((p) => p.equals(nbr))) {
            newQueue.push(nbr);
          }
        }
      } else {
        qubit.setValue(current.ortho);
      }
    }
    this.measureQueue = uniqWith(newQueue, (a, b) => a.equals(b));
  }

  resolveMeasurement() {
    const uniqMeasured = uniqWith(this.measured, (a, b) => a.equals(b));
    this.score += triangular(uniqMeasured.length);
    for (const point of uniqMeasured) {
      this.board.setPiece(point, null);
    }
    this.measured = [];
    this.measureQueue = [];
    this.visited = [];
    this.view.removeChild(this.current!.sprite);
    this.currentState = "fall";
  }

  fallStep() {
    let anyFalling = false;
    for (let x = 0; x < BOARD_WIDTH; x++) {
      for (let y = BOARD_HEIGHT - 2; y >= 0; y--) {
        const point = new Point(x, y);
        if (
          this.board.containsPoint(point) &&
          !this.board.containsPoint(point.add(DOWN))
        ) {
          const piece = this.board.getPiece(point);
          this.board.setPiece(point, null);
          this.board.setPiece(point.add(DOWN), piece);
          anyFalling = true;
        }
      }
    }
    if (!anyFalling) {
      this.currentState = "game";
      this.newCurrent();
    }
  }

  newCurrent() {
    this.current = this.deck.pop();
    this.setCurrentPosition(startingCell);
    this.view.addChild(this.current.sprite);
  }

  setCurrentPosition(p: Point) {
    this.currentPosition = p;
    this.current!.sprite.position = {
      x: (this.currentPosition.x + 0.5) * CELL_SIZE,
      y: (this.currentPosition.y + 0.5) * CELL_SIZE,
    };
  }

  handleKeyDown = (e: KeyboardEvent) => {
    if (this.currentState !== "game") {
      return;
    }
    switch (e.key) {
      // If the player presses left or right, move the current item (if possible)
      case "a":
      case "ArrowLeft": {
        const left = this.currentPosition.add(LEFT);
        if (this.board.containsPoint(left)) break;
        if (left.x < 0) break;
        if (
          this.current instanceof QubitPair &&
          this.current.orientation === "vertical" &&
          this.board.containsPoint(left.add(UP))
        )
          break;
        this.setCurrentPosition(left);
        break;
      }
      case "d":
      case "ArrowRight": {
        const right = this.currentPosition.add(RIGHT);
        if (this.board.containsPoint(right)) break;
        if (right.x >= BOARD_WIDTH) break;
        if (this.current instanceof QubitPair) {
          if (
            this.current.orientation === "vertical" &&
            this.board.containsPoint(right.add(UP))
          ) {
            break;
          }
          const right2 = right.add(RIGHT);
          if (
            this.current.orientation === "horizontal" &&
            (this.board.containsPoint(right2) || right2.x >= BOARD_WIDTH)
          )
            break;
        }
        this.setCurrentPosition(right);
        break;
      }
      // If the player presses down, speed up the steps
      case "s":
      case "ArrowDown": {
        let obstructed = false;
        const down = this.currentPosition.add(DOWN);
        if (this.board.containsPoint(down)) obstructed = true;
        if (down.y >= BOARD_HEIGHT) obstructed = true;
        if (
          this.current instanceof QubitPair &&
          this.current.orientation === "horizontal" &&
          this.board.containsPoint(down.add(RIGHT))
        ) {
          obstructed = true;
        }

        if (obstructed) {
          this.resolve();
        } else {
          this.setCurrentPosition(down);
        }
        break;
      }
      // If the player presses the trigger, rotate the qubit (if possible)
      case " ": {
        // Can only rotate qubit pairs
        if (!(this.current instanceof QubitPair)) {
          break;
        }
        if (this.current.orientation === "vertical") {
          const right = this.currentPosition.add(RIGHT);
          if (this.board.containsPoint(right) || !inBounds(right)) {
            break;
          }
        }
        if (this.current.orientation === "horizontal") {
          if (this.board.containsPoint(this.currentPosition.add(UP))) {
            break;
          }
        }
        this.current.rotate();
        break;
      }
    }
  };
}

function triangular(n: number) {
  return (n * (n - 1)) / 2;
}

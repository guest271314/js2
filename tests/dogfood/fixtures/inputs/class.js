class Counter {
  constructor(start) {
    this.count = start;
  }

  increment() {
    this.count += 1;
    return this.count;
  }

  get value() {
    return this.count;
  }
}

const c = new Counter(0);
c.increment();

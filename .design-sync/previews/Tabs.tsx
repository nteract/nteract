import { Tabs, TabsContent, TabsList, TabsTrigger } from "nteract-elements";

export function NotebookInspector() {
  return (
    <Tabs defaultValue="outline" style={{ width: 380 }}>
      <TabsList>
        <TabsTrigger value="outline">Outline</TabsTrigger>
        <TabsTrigger value="variables">Variables</TabsTrigger>
        <TabsTrigger value="packages">Packages</TabsTrigger>
      </TabsList>
      <TabsContent value="outline">
        <div className="flex flex-col gap-1 text-sm">
          <div>1. Load events dataset</div>
          <div className="pl-3 text-muted-foreground">1.1 Read parquet</div>
          <div className="pl-3 text-muted-foreground">1.2 Drop nulls</div>
          <div>2. Train baseline model</div>
          <div>3. Evaluate on holdout</div>
        </div>
      </TabsContent>
      <TabsContent value="variables">
        <div className="text-sm text-muted-foreground">df, model, X_train, y_train</div>
      </TabsContent>
      <TabsContent value="packages">
        <div className="text-sm text-muted-foreground">numpy, pandas, scikit-learn</div>
      </TabsContent>
    </Tabs>
  );
}

export function RuntimeStatus() {
  return (
    <Tabs defaultValue="output" style={{ width: 380 }}>
      <TabsList>
        <TabsTrigger value="output">Output</TabsTrigger>
        <TabsTrigger value="logs">Kernel logs</TabsTrigger>
      </TabsList>
      <TabsContent value="output">
        <div className="rounded bg-muted p-2 font-mono text-xs">
          Epoch 3/10 - loss: 0.214 - accuracy: 0.931
        </div>
      </TabsContent>
      <TabsContent value="logs">
        <div className="text-sm text-muted-foreground">
          [runtimed] kernel python3.12 idle after 1.2s
        </div>
      </TabsContent>
    </Tabs>
  );
}

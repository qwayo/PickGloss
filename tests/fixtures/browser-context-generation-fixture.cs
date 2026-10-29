using System;

// 确定性交错：快照完成后先提交 UIA 事件，再尝试提交旧快照。
public static class BrowserContextGenerationFixture {
    public static int Main() {
        object outputGate=new object();
        BrowserContextObservationGate gate=new BrowserContextObservationGate(outputGate);
        string guardedState="active";
        long capturedGeneration=gate.Begin();
        bool snapshotReadCompleted=true;
        if(!snapshotReadCompleted) return 1;

        gate.Observe(delegate(bool wasInvalid) { if(!wasInvalid) guardedState="inactive"; },false);
        bool staleCommitAccepted=gate.TryCommit(capturedGeneration,delegate { guardedState="active"; },false);
        bool guardedSafetyPass=!staleCommitAccepted && guardedState=="inactive";

        // 对照模拟移除代际检查后的旧提交；同一交错会把已隐藏状态错误恢复为 active。
        string unguardedState="active";
        unguardedState="inactive";
        Action staleUnguardedCommit=delegate { unguardedState="active"; };
        staleUnguardedCommit();
        bool unguardedSafetyPass=unguardedState=="inactive";

        if(!guardedSafetyPass || unguardedSafetyPass) return 2;
        Console.WriteLine("guarded=reject;unguarded=unsafe");
        return 0;
    }
}

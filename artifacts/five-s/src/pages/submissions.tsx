import { useListSubmissions, useListAreas } from "@workspace/api-client-react";
import { useState } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { CheckCircle2, ArrowRight } from "lucide-react";

export default function Submissions() {
  const [shiftFilter, setShiftFilter] = useState<string>("");
  const [areaFilter, setAreaFilter] = useState<string>("");
  const [dateFilter, setDateFilter] = useState<string>("");
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<number | null>(null);

  const { data: areas } = useListAreas();
  const { data: submissions, isLoading } = useListSubmissions({
    shift: shiftFilter ? shiftFilter as any : undefined,
    areaId: areaFilter ? parseInt(areaFilter) : undefined,
    date: dateFilter ? dateFilter : undefined,
  });

  const selectedSubmission = submissions?.find(s => s.id === selectedSubmissionId);

  return (
    <div className="space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-muted-foreground mt-1">Review 5S photo submissions across all shifts and areas.</p>
      </div>

      <Card className="border-border shadow-sm">
        <CardHeader className="bg-muted/30 border-b border-border pb-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs uppercase font-bold text-muted-foreground">Date</Label>
              <Input 
                type="date" 
                value={dateFilter} 
                onChange={(e) => setDateFilter(e.target.value)}
                className="bg-white"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs uppercase font-bold text-muted-foreground">Shift</Label>
              <Select value={shiftFilter} onValueChange={setShiftFilter}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="All Shifts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Shifts</SelectItem>
                  <SelectItem value="A">Shift A</SelectItem>
                  <SelectItem value="B">Shift B</SelectItem>
                  <SelectItem value="C">Shift C</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs uppercase font-bold text-muted-foreground">Area</Label>
              <Select value={areaFilter} onValueChange={setAreaFilter}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="All Areas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Areas</SelectItem>
                  {areas?.map(a => (
                    <SelectItem key={a.id} value={a.id.toString()}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/10 hover:bg-muted/10">
                  <TableHead className="font-bold">Photo</TableHead>
                  <TableHead className="font-bold">Area</TableHead>
                  <TableHead className="font-bold">Shift</TableHead>
                  <TableHead className="font-bold">Score</TableHead>
                  <TableHead className="font-bold">Time</TableHead>
                  <TableHead className="font-bold">Operator</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      Loading submissions...
                    </TableCell>
                  </TableRow>
                ) : submissions?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground font-medium">
                      No submissions found matching criteria.
                    </TableCell>
                  </TableRow>
                ) : (
                  submissions?.map((sub) => (
                    <TableRow 
                      key={sub.id} 
                      className="cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setSelectedSubmissionId(sub.id)}
                    >
                      <TableCell>
                        <div className="w-16 h-12 rounded bg-muted overflow-hidden border border-border">
                          <img src={`/api${sub.imageUrl}`} alt="" className="w-full h-full object-cover" />
                        </div>
                      </TableCell>
                      <TableCell className="font-bold">{sub.areaName}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-md font-bold text-xs bg-secondary/10 text-secondary-foreground border border-secondary/20">
                          {sub.shift}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={`font-bold ${sub.scoreTotal >= 20 ? 'text-green-600' : sub.scoreTotal >= 15 ? 'text-yellow-600' : 'text-red-600'}`}>
                          {sub.scoreTotal}/25
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {format(new Date(sub.createdAt), "MMM d, HH:mm")}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {sub.userEmail}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selectedSubmission} onOpenChange={(open) => !open && setSelectedSubmissionId(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          {selectedSubmission && (
            <>
              <DialogHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <DialogTitle className="text-2xl">{selectedSubmission.areaName}</DialogTitle>
                    <DialogDescription className="text-base mt-1">
                      Submitted {format(new Date(selectedSubmission.createdAt), "MMM d, yyyy 'at' h:mm a")} by {selectedSubmission.userEmail} (Shift {selectedSubmission.shift})
                    </DialogDescription>
                  </div>
                  <div className={`px-4 py-2 rounded-lg border-2 font-bold text-xl ${
                    selectedSubmission.scoreTotal >= 20 ? 'text-green-600 border-green-200 bg-green-50' : 
                    selectedSubmission.scoreTotal >= 15 ? 'text-yellow-600 border-yellow-200 bg-yellow-50' : 
                    'text-red-600 border-red-200 bg-red-50'
                  }`}>
                    {selectedSubmission.scoreTotal} / 25
                  </div>
                </div>
              </DialogHeader>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <div className="rounded-xl overflow-hidden border-2 border-border shadow-sm">
                    <img 
                      src={`/api${selectedSubmission.imageUrl}`} 
                      alt="Submission" 
                      className="w-full h-auto object-contain bg-black/5" 
                    />
                  </div>
                </div>
                <div className="space-y-6">
                  <div>
                    <h3 className="font-bold text-lg border-b pb-2 mb-3">Score Breakdown</h3>
                    <div className="space-y-3">
                      {Object.entries(selectedSubmission.scoreJson || {}).map(([key, value]) => (
                        <div key={key} className="flex justify-between items-center">
                          <span className="capitalize font-medium text-muted-foreground">{key}</span>
                          <div className="flex items-center gap-2">
                            <div className="w-32 h-2.5 bg-muted rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-primary" 
                                style={{ width: `${((value as number) / 5) * 100}%` }}
                              />
                            </div>
                            <span className="font-bold w-8 text-right">{value}/5</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3 className="font-bold text-lg border-b pb-2 mb-3">AI Suggestions</h3>
                    <ul className="space-y-3">
                      {selectedSubmission.suggestionsJson?.map((suggestion, i) => (
                        <li key={i} className="flex gap-2.5 items-start bg-secondary/5 p-3 rounded-lg border border-secondary/10">
                          <ArrowRight className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                          <span className="text-sm font-medium leading-relaxed">{suggestion}</span>
                        </li>
                      ))}
                      {(!selectedSubmission.suggestionsJson || selectedSubmission.suggestionsJson.length === 0) && (
                        <li className="text-muted-foreground italic flex items-center gap-2 p-3 bg-green-50 text-green-700 rounded-lg border border-green-100">
                          <CheckCircle2 className="w-5 h-5" /> No immediate improvement suggestions.
                        </li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
